/**
 * Repository maintenance and cleanup operations
 *
 * This module handles idle cleanup, R2 mirror management,
 * and periodic pack pruning to maintain repository health.
 */

import { r2PackDirPrefix, isPackKey, packIndexKey, doPrefix } from '@git/keys';

import { getDb as getDatabase } from './db/client';
import { deletePackObjects, getPackOids as getPackOidsHelper, normalizePackKey } from './db/index';
import { enqueueHydrationTask } from './hydration/index';
import { calculateStableEpochs } from './packs';
import { getConfig } from './repo-config';
import { asTypedStorage } from './repo-state';
import { ensureScheduled } from './scheduler';

import type { RepoStateSchema } from './repo-state';
import type { Logger } from '@git/common/logger';

/**
 * Handles idle cleanup and periodic maintenance tasks
 * Checks if the repository should be cleaned up due to idleness,
 * and performs periodic maintenance (pack pruning) if due
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @param logger - Logger instance
 */
export async function handleIdleAndMaintenance(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	logger?: Logger,
): Promise<void> {
	try {
		const cfg = getConfig(environment);
		const now = Date.now();
		const store = asTypedStorage<RepoStateSchema>(context.storage);
		const lastAccess = await store.get('lastAccessMs');
		const lastMaint = await store.get('lastMaintenanceMs');

		// Check if idle cleanup is needed
		if (await shouldCleanupIdle(store, cfg.idleMs, lastAccess)) {
			await performIdleCleanup(context, environment, logger);
			return;
		}

		// Check if maintenance is due
		if (isMaintenanceDue(lastMaint, now, cfg.maintMs)) {
			await performMaintenance(context, environment, cfg.keepPacks, now, logger);
		}

		// Schedule next alarm via unified scheduler
		await ensureScheduled(context, environment, now);
	} catch (error) {
		logger?.error('alarm:error', { error: String(error) });
	}
}

/**
 * Determines if the repository should be cleaned up due to idleness
 * A repo is considered for cleanup if it's been idle beyond the threshold
 * AND appears empty (no refs, unborn/missing HEAD, no packs)
 * @param store - The typed storage instance
 * @param idleMs - Idle threshold in milliseconds
 * @param lastAccess - Last access timestamp
 * @returns true if cleanup should proceed
 */
async function shouldCleanupIdle(
	store: ReturnType<typeof asTypedStorage<RepoStateSchema>>,
	idleMs: number,
	lastAccess: number | undefined,
): Promise<boolean> {
	const now = Date.now();
	const idleExceeded = !lastAccess || now - lastAccess >= idleMs;
	if (!idleExceeded) return false;

	// Check if repo looks empty
	const references = (await store.get('refs')) ?? [];
	const head = await store.get('head');
	const lastPackKey = await store.get('lastPackKey');

	return references.length === 0 && (!head || head.unborn || !head.target) && !lastPackKey;
}

/**
 * Performs complete cleanup of an idle repository
 * Deletes all DO storage and purges the R2 mirror
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @param logger - Logger instance
 */
async function performIdleCleanup(context: DurableObjectState, environment: GitWorkerEnvironment, logger?: Logger): Promise<void> {
	const storage = context.storage;

	// Purge DO storage
	try {
		await storage.deleteAll();
	} catch (error) {
		logger?.error('cleanup:delete-storage-failed', { error: String(error) });
	}

	// Purge R2 mirror
	const prefix = doPrefix(context.id.toString());
	await purgeR2Mirror(environment, prefix, logger);

	// Clear the alarm after cleanup
	try {
		await storage.deleteAlarm();
	} catch (error) {
		logger?.warn('cleanup:delete-alarm-failed', { error: String(error) });
	}
}

/**
 * Purges all R2 objects under this DO's prefix
 * Continues even if individual deletes fail
 * @param env - Worker environment
 * @param prefix - Repository prefix (do/<id>)
 * @param logger - Logger instance
 */
async function purgeR2Mirror(environment: GitWorkerEnvironment, prefix: string, logger?: Logger): Promise<void> {
	try {
		const pfx = `${prefix}/`;
		let cursor: string | undefined = undefined;

		do {
			const res: R2Objects = await environment.REPO_BUCKET.list({ prefix: pfx, cursor });
			const objects: R2Object[] = (res && res.objects) || [];

			for (const object of objects) {
				try {
					await environment.REPO_BUCKET.delete(object.key);
				} catch (error) {
					logger?.warn('cleanup:delete-r2-object-failed', {
						key: object.key,
						error: String(error),
					});
				}
			}

			cursor = res.truncated ? res.cursor : undefined;
		} while (cursor);
	} catch (error) {
		logger?.error('cleanup:purge-r2-failed', { error: String(error) });
	}
}

/**
 * Check if maintenance is due
 * @param lastMaint - Last maintenance timestamp
 * @param now - Current timestamp
 * @param maintMs - Maintenance interval in milliseconds
 * @returns true if maintenance is due
 */
function isMaintenanceDue(lastMaint: number | undefined, now: number, maintMs: number): boolean {
	return !lastMaint || now - lastMaint >= maintMs;
}

/**
 * Perform periodic maintenance
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @param keepPacks - Number of packs to keep
 * @param now - Current timestamp
 * @param logger - Logger instance
 */
async function performMaintenance(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	keepPacks: number,
	now: number,
	logger?: Logger,
): Promise<void> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	try {
		// Deletes older packs beyond the keep-window from both DO metadata and R2,
		// and keeps `lastPackKey/lastPackOids` consistent
		const prefix = doPrefix(context.id.toString());
		await runMaintenance(context, environment, prefix, keepPacks, logger);
		await store.put('lastMaintenanceMs', now);
	} catch (error) {
		logger?.error('maintenance:failed', { error: String(error) });
	}
}

/**
 * Run pack maintenance, pruning old packs
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @param prefix - Repository prefix
 * @param keepPacks - Number of packs to keep
 * @param logger - Logger instance
 */
async function runMaintenance(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	keepPacks: number,
	logger?: Logger,
): Promise<void> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	const database = getDatabase(context.storage);

	// Ensure packList exists
	const packList = (await store.get('packList')) ?? [];
	if (packList.length === 0) return;

	// Prune safety: avoid pruning before hydration has produced at least one segment.
	// If no hydration packs exist (basename starts with 'pack-hydr-'), skip pruning now.
	try {
		const hasHydration = Array.isArray(packList) ? packList.some((k: string) => normalizePackKey(k).startsWith('pack-hydr-')) : false;
		if (!hasHydration) {
			logger?.warn?.('maintenance:prune-skipped:no-hydration', { count: packList.length });
			return;
		}
	} catch {}

	// Determine which packs to keep using epoch-aware selection with soft KEEP_PACKS
	const currentLast = (await store.get('lastPackKey')) || undefined;
	const { keepSet } = calculateStableEpochs(packList, keepPacks, currentLast);
	const removed = packList.filter((k) => !keepSet.has(k));
	const newList = packList.filter((k) => keepSet.has(k));
	// Track whether any hydration packs (pack-hydr-*) were pruned; used to decide whether we
	// need to enqueue a follow-up hydration job. This avoids oscillation when only normal packs
	// are pruned but hydration coverage remains intact.
	const removedHydra = removed.filter((k) => normalizePackKey(k).startsWith('pack-hydr-'));

	// Trim packList in storage while preserving additional kept keys
	if (removed.length > 0) await store.put('packList', newList);

	// Adjust lastPackKey/lastPackOids if needed
	const lastPackKey = await store.get('lastPackKey');
	if (!lastPackKey || !keepSet.has(lastPackKey)) {
		// Choose the newest kept pack as the latest reference
		const newest = newList[0];
		if (newest) {
			await store.put('lastPackKey', newest);
			// Load OIDs from SQLite for the newest pack via DAL
			const oids = await getPackOidsHelper(database, newest);
			await store.put('lastPackOids', oids.slice(0, 10_000));
		} else {
			// No packs remain
			await store.delete('lastPackKey');
			await store.delete('lastPackOids');
		}
	}

	// Delete pack_objects entries for removed packs from SQLite
	for (const k of removed) {
		try {
			await deletePackObjects(database, k);
		} catch (error) {
			logger?.warn('maintenance:delete-packObjects-failed', { key: k, error: String(error) });
		}
	}

	// Proactively delete removed packs (.pack and .idx) by base key
	for (const base of removed) {
		try {
			await environment.REPO_BUCKET.delete(base);
		} catch {}
		try {
			await environment.REPO_BUCKET.delete(packIndexKey(base));
		} catch {}
	}

	// Sweep R2 pack files not in keep set
	try {
		const pfx = r2PackDirPrefix(prefix);
		let cursor: string | undefined = undefined;
		const packKeys: string[] = [];

		do {
			const res: any = await environment.REPO_BUCKET.list({ prefix: pfx, cursor });
			const objects: any[] = (res && res.objects) || [];
			for (const object of objects) {
				const key: string = object.key;
				if (isPackKey(key)) packKeys.push(key);
			}
			cursor = res && res.truncated ? res.cursor : undefined;
		} while (cursor);

		for (const packKey of packKeys) {
			if (!keepSet.has(packKey)) {
				try {
					await environment.REPO_BUCKET.delete(packKey);
				} catch {}
				try {
					await environment.REPO_BUCKET.delete(packIndexKey(packKey));
				} catch {}
			}
		}
	} catch {}

	// Enqueue a hydration job only when hydration packs were pruned. If pruning removed
	// only normal packs, hydration coverage remains and we avoid unnecessary re-hydration.
	if (removedHydra.length > 0) {
		try {
			await enqueueHydrationTask(context, environment, { reason: 'post-maint' });
		} catch (error) {
			logger?.warn?.('maintenance:enqueue-hydration-failed', { error: String(error) });
		}
	}
}
