import {
	getDb as getDatabase,
	getPackOids as getPackOidsHelper,
	getPackOidsBatch as getPackOidsBatchHelper,
	deletePackObjects,
	normalizePackKey,
} from './db/index';
import { getConfig } from './repo-config';
import { asTypedStorage } from './repo-state';

import type { RepoStateSchema } from './repo-state';
import type { Logger } from '@git/common/logger';

/**
 * Pack management operations for Git repository
 *
 * This module handles pack metadata and membership tracking,
 * including pack lists, OID memberships, and batch operations.
 */

/**
 * Get the latest pack information with its OIDs
 * @param ctx - Durable Object state context
 * @returns Latest pack key and OIDs, or null if no packs exist
 */
export async function getPackLatest(context: DurableObjectState): Promise<{ key: string; oids: string[] } | null> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	const key = await store.get('lastPackKey');
	if (!key) return null;
	const oids = ((await store.get('lastPackOids')) || []).slice(0, 10_000);
	return { key, oids };
}

/**
 * Get list of pack keys (newest first)
 * @param ctx - Durable Object state context
 * @param env - Worker environment for configuration
 * @returns Array of pack keys, limited to configured packListMax
 */
export async function getPacks(context: DurableObjectState, environment: GitWorkerEnvironment): Promise<string[]> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	const cfg = getConfig(environment);
	const list = ((await store.get('packList')) || []).slice(0, cfg.packListMax);
	return list;
}

/**
 * Get OIDs contained in a specific pack
 * @param ctx - Durable Object state context
 * @param key - Pack key to get OIDs for
 * @returns Array of OIDs in the pack
 */
export async function getPackOids(context: DurableObjectState, key: string): Promise<string[]> {
	if (!key) return [];
	const database = getDatabase(context.storage);
	return await getPackOidsHelper(database, key);
}

/**
 * Batch API: Retrieve OID membership arrays for multiple pack keys in one call
 * Uses DurableObjectStorage.get([...]) to reduce roundtrips and total subrequests
 * @param ctx - Durable Object state context
 * @param keys - Pack keys to fetch membership for
 * @param logger - Logger instance
 * @returns Map of pack key -> string[] of OIDs (empty array if missing)
 */
export async function getPackOidsBatch(context: DurableObjectState, keys: string[], logger?: Logger): Promise<Map<string, string[]>> {
	try {
		if (!Array.isArray(keys) || keys.length === 0) return new Map();
		const database = getDatabase(context.storage);
		return await getPackOidsBatchHelper(database, keys);
	} catch (error) {
		logger?.debug('getPackOidsBatch:error', { error: String(error), count: keys?.length || 0 });
		return new Map();
	}
}

/**
 * Remove pack from list and clean up its metadata
 * @param ctx - Durable Object state context
 * @param packKey - Pack key to remove
 */
export async function removePackFromList(context: DurableObjectState, packKey: string): Promise<void> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	const database = getDatabase(context.storage);

	// Remove from pack list — compare both exact and normalized forms
	// to handle mixed full-R2-path vs basename representations
	const normalizedInput = normalizePackKey(packKey);
	const packList = (await store.get('packList')) || [];
	const newList = packList.filter((k) => k !== packKey && normalizePackKey(k) !== normalizedInput);
	await store.put('packList', newList);

	// Clean up pack OIDs (DAL normalizes internally)
	await deletePackObjects(database, packKey);

	// Update lastPackKey if necessary
	const lastPackKey = await store.get('lastPackKey');
	if (lastPackKey === packKey || normalizePackKey(lastPackKey ?? '') === normalizedInput) {
		if (newList.length > 0) {
			const newest = newList[0];
			await store.put('lastPackKey', newest);
			// Load OIDs from SQLite for the newest pack
			const oids = await getPackOidsHelper(database, newest);
			await store.put('lastPackOids', oids.slice(0, 10_000));
		} else {
			await store.delete('lastPackKey');
			await store.delete('lastPackOids');
		}
	}
}

/**
 * Parse epoch identifier from a hydration pack key.
 * Returns e<...> when key matches pack-hydr-e<epoch>-<seq>.pack; otherwise null.
 */
export function parseEpochFromHydrPackKey(key: string): string | null {
	try {
		const base = normalizePackKey(key);
		const m = base.match(/pack-hydr-(e[0-9A-Za-z]+)-\d+\.pack$/);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

/**
 * Derive epoch id from hydration workId. Example: hydr-1727082945000 -> e1727082945000
 */
export function getEpochFromWorkId(workId: string): string {
	if (workId && workId.startsWith('hydr-')) {
		return `e${workId.slice(5)}`;
	}
	return `e${workId || Date.now()}`;
}

/**
 * Calculate stable epochs and an epoch-aware keep set for maintenance.
 * - Units: [last?], then hydration epochs (atomic groups), then normal packs
 * - Do not split epochs. If next epoch would cross keepPacks, include entire epoch and stop.
 * - Legacy hydration packs (no epoch) are not considered part of stable epochs or keep set
 *   when tight on space (they will naturally fall out when keep horizon is small).
 */
export function calculateStableEpochs(
	packList: string[],
	keepPacks: number,
	lastPackKey?: string,
): { stableEpochs: string[]; keepSet: Set<string> } {
	const seen = new Set<string>();
	const hydrationByEpoch = new Map<string, string[]>();
	const normals: string[] = [];

	for (const k of packList) {
		if (seen.has(k)) continue;
		seen.add(k);
		const epoch = parseEpochFromHydrPackKey(k);
		if (epoch) {
			const array = hydrationByEpoch.get(epoch) || [];
			array.push(k);
			hydrationByEpoch.set(epoch, array);
		} else if (k !== lastPackKey) {
			// Exclude legacy hydration (pack-hydr-*) from normals to avoid prioritizing them
			const base = normalizePackKey(k);
			if (!base.startsWith('pack-hydr-')) normals.push(k);
		}
	}

	type Unit = { kind: 'last' | 'epoch' | 'normal'; id?: string; keys: string[] };
	const units: Unit[] = [];
	if (lastPackKey) units.push({ kind: 'last', keys: [lastPackKey] });
	// Preserve list order for epochs as they appear in packList
	for (const k of packList) {
		const e = parseEpochFromHydrPackKey(k);
		if (e && hydrationByEpoch.has(e)) {
			const keys = hydrationByEpoch.get(e)!;
			units.push({ kind: 'epoch', id: e, keys });
			hydrationByEpoch.delete(e);
		}
	}
	for (const n of normals) units.push({ kind: 'normal', keys: [n] });

	let kept = 0;
	const keepSet = new Set<string>();
	const stableEpochs: string[] = [];

	for (const u of units) {
		const weight = u.keys.length;
		if (u.kind === 'epoch') {
			if (kept + weight <= keepPacks) {
				for (const k of u.keys) keepSet.add(k);
				stableEpochs.push(u.id!);
				kept += weight;
			} else if (kept < keepPacks) {
				for (const k of u.keys) keepSet.add(k);
				stableEpochs.push(u.id!);
				kept += weight;
				break;
			} else {
				break;
			}
		} else {
			if (kept + weight <= keepPacks) {
				for (const k of u.keys) keepSet.add(k);
				kept += weight;
			} else {
				break;
			}
		}
	}

	return { stableEpochs, keepSet };
}
