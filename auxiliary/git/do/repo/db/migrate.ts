import { packOidsKey, asTypedStorage, type RepoStateSchema } from '../repo-state';
import { insertPackOids, getPackObjectCount, normalizePackKeysInPlace } from './dal';

import type { Logger } from '@git/common/logger';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

/**
 * Best-effort one-time migration: backfill pack memberships from KV (packOids:* keys)
 * into SQLite pack_objects, then delete migrated KV keys to avoid 2MB per-key risks.
 */
export async function migrateKvToSql(context: DurableObjectState, database: DrizzleSqliteDODatabase, logger?: Logger) {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	const list = (await store.get('packList')) || [];
	if (!Array.isArray(list) || list.length === 0) {
		logger?.debug('kv->sqlite:skip', { reason: 'empty packList' });
		return;
	}

	// First normalize any existing rows in place so subsequent counts match by basename
	try {
		await normalizePackKeysInPlace(database, logger);
	} catch (error) {
		logger?.warn('kv->sqlite:normalize-initial:error', { error: String(error) });
	}

	// Fast path: if there are oids for the last (oldest) pack, we already migrated
	const oldestPackKey = list.at(-1);
	if (!oldestPackKey) return;
	const count = await getPackObjectCount(database, oldestPackKey);
	if (count > 0) {
		logger?.debug('kv->sqlite:skip', { reason: 'oldest packKey contains oids' });
		return;
	}

	// Process each pack; skip if SQL already has rows for this pack
	let migrated = 0;
	for (const packKey of list) {
		try {
			const pc = await getPackObjectCount(database, packKey);
			if (pc > 0) {
				logger?.debug('kv->sqlite:skip', { packKey, reason: 'already migrated' });
				continue; // already migrated
			}

			const array = (await store.get(packOidsKey(packKey))) || [];
			if (!Array.isArray(array) || array.length === 0) {
				logger?.debug('kv->sqlite:skip', { packKey, reason: 'no oids' });
				continue;
			}

			// Parameter-limit-safe insert via centralized helper (stores basename)
			await insertPackOids(database, packKey, array);

			// After successful insert, delete KV key to reduce storage
			await store.delete(packOidsKey(packKey));
			migrated++;
		} catch (error) {
			logger?.warn('kv->sqlite:migrate-pack-failed', { packKey, error: String(error) });
		}
	}
	if (migrated > 0) logger?.info('kv->sqlite:migrated', { packs: migrated });

	// Final normalization pass (idempotent)
	try {
		await normalizePackKeysInPlace(database, logger);
	} catch (error) {
		logger?.warn('kv->sqlite:normalize-final:error', { error: String(error) });
	}
}
