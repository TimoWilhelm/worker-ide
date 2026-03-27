/**
 * Pack operations for repository maintenance
 *
 * This module provides operations for managing packs including
 * removal of specific packs and complete repository purging.
 */

import { createLogger } from '@git/common';
import { doPrefix, packIndexKey } from '@git/keys';

import { removePackFromList } from './packs';
import { asTypedStorage } from './repo-state';

import type { RepoStateSchema } from './repo-state';

/**
 * Remove a specific pack file and its associated data
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @param packKey - The pack key to remove (can be either short name or full R2 key)
 * @returns Object with removal statistics
 */
export async function removePack(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	packKey: string,
): Promise<{
	removed: boolean;
	deletedPack: boolean;
	deletedIndex: boolean;
	deletedMetadata: boolean;
}> {
	const log = createLogger(environment.LOG_LEVEL, {
		service: 'packOperations:removePack',
		doId: context.id.toString(),
	});

	const result = {
		removed: false,
		deletedPack: false,
		deletedIndex: false,
		deletedMetadata: false,
	};

	try {
		// Normalize the pack key - if it's just a filename, construct the full R2 key
		const prefix = doPrefix(context.id.toString());
		let fullPackKey = packKey;

		// If the key doesn't start with our prefix, it's likely just the filename
		if (!packKey.startsWith(prefix)) {
			// Check if it's in the pack list to get the full key
			const store = asTypedStorage<RepoStateSchema>(context.storage);
			const packList = (await store.get('packList')) || [];

			// Find the full key in the pack list that ends with this filename
			const matchingKey = packList.find((k) => k.endsWith(packKey) || k.endsWith(`/${packKey}`));

			if (matchingKey) {
				fullPackKey = matchingKey;
			} else {
				// If not found in list, construct the expected path
				fullPackKey = `${prefix}/objects/pack/${packKey}`;
			}
		}

		log.info('removing-pack', { packKey: fullPackKey });

		// Delete the pack file from R2
		try {
			await environment.REPO_BUCKET.delete(fullPackKey);
			result.deletedPack = true;
			log.info('deleted-pack-file', { key: fullPackKey });
		} catch (error) {
			log.error('failed-to-delete-pack', { key: fullPackKey, error: String(error) });
		}

		// Delete the index file from R2 if it exists
		const indexKey = packIndexKey(fullPackKey);
		try {
			await environment.REPO_BUCKET.delete(indexKey);
			result.deletedIndex = true;
			log.info('deleted-index-file', { key: indexKey });
		} catch {
			log.debug('no-index-to-delete', { key: indexKey });
		}

		// Remove from DO metadata
		await removePackFromList(context, fullPackKey);
		result.deletedMetadata = true;

		result.removed = result.deletedPack || result.deletedMetadata;

		log.info('pack-removal-complete', result);
	} catch (error) {
		log.error('pack-removal-error', { packKey, error: String(error) });
		throw error;
	}

	return result;
}

/**
 * DANGEROUS: Completely purge all repository data
 * Deletes all R2 objects and all DO storage
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @returns Statistics about deleted objects
 */
export async function purgeRepo(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
): Promise<{ deletedR2: number; deletedDO: boolean }> {
	const log = createLogger(environment.LOG_LEVEL, {
		service: 'packOperations:purgeRepo',
		doId: context.id.toString(),
	});

	let deletedR2 = 0;
	const prefix = doPrefix(context.id.toString());

	// Delete all R2 objects for this repo
	try {
		// List and delete all objects under do/<id>/
		let cursor: string | undefined;
		do {
			const res = await environment.REPO_BUCKET.list({ prefix, cursor });
			const objects = res.objects || [];

			if (objects.length > 0) {
				// Delete in batches
				const keys = objects.map((o) => o.key);
				await environment.REPO_BUCKET.delete(keys);
				deletedR2 += keys.length;
				log.info('purge:deleted-r2-batch', { count: keys.length });
			}

			cursor = res.truncated ? res.cursor : undefined;
		} while (cursor);
	} catch (error) {
		log.error('purge:r2-delete-error', { error: String(error) });
	}

	// Delete all DO storage
	await context.storage.deleteAll();
	log.info('purge:deleted-do-storage');

	return { deletedR2, deletedDO: true };
}
