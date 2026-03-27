/**
 * Data Access Layer (DAL) for repository database operations
 */

import { eq, inArray, and, sql } from 'drizzle-orm';

import { packObjects, hydrCover, hydrPending } from './schema';

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

/**
 * Safe maximum bound parameters per SQLite query on the platform.
 * Keep some headroom below the documented 100 to account for potential
 * extra bound params Drizzle may include.
 */
const SAFE_ROWS_2COL = 45; // 2 columns per row -> 90 params (< 100)
const SAFE_ROWS_3COL = 30; // 3 columns per row -> 90 params (< 100)

/**
 * Normalize a pack key to its basename (e.g. "pack-123.pack").
 * We persist only basenames in SQLite to reduce storage amplification.
 */
export function normalizePackKey(key: string): string {
	if (!key) return key;
	const index = key.lastIndexOf('/');
	return index === -1 ? key : key.slice(index + 1);
}

/**
 * Check if an OID exists in any pack
 * Uses the index on oid column for efficient lookup
 */
export async function oidExistsInPacks(database: DrizzleSqliteDODatabase, oid: string): Promise<boolean> {
	const result = await database
		.select({ packKey: packObjects.packKey })
		.from(packObjects)
		.where(eq(packObjects.oid, oid.toLowerCase()))
		.limit(1);
	return result.length > 0;
}

/**
 * Get the number of objects recorded for a pack key.
 * The input may be a full path; counting uses the normalized basename.
 */
export async function getPackObjectCount(database: DrizzleSqliteDODatabase, packKey: string): Promise<number> {
	const key = normalizePackKey(packKey);
	const count = await database.$count(packObjects, eq(packObjects.packKey, key));
	return count;
}

/**
 * One-time SQL normalization: rewrite any rows whose pack_key includes a '/'
 * to store only the basename. Safe to run multiple times.
 */
export async function normalizePackKeysInPlace(
	database: DrizzleSqliteDODatabase,
	logger?: {
		debug?: (m: string, d?: any) => void;
		info?: (m: string, d?: any) => void;
		warn?: (m: string, d?: any) => void;
	},
): Promise<{ checked: number; updated: number }> {
	// Select distinct pack keys that appear to be full paths
	const rows = await database
		.select({ packKey: packObjects.packKey })
		.from(packObjects)
		.where(sql`instr(${packObjects.packKey}, '/') > 0`)
		.groupBy(packObjects.packKey);

	let updated = 0;
	for (const r of rows) {
		const oldKey = r.packKey as string;
		const newKey = normalizePackKey(oldKey);
		if (newKey !== oldKey) {
			try {
				await database.update(packObjects).set({ packKey: newKey }).where(eq(packObjects.packKey, oldKey));
				updated++;
			} catch (error) {
				logger?.warn?.('normalize:packKey:update-failed', { oldKey, newKey, error: String(error) });
			}
		}
	}
	if (updated > 0) logger?.info?.('normalize:packKey:updated', { updated, checked: rows.length });
	else logger?.debug?.('normalize:packKey:noop', { checked: rows.length });
	return { checked: rows.length, updated };
}

/**
 * Find all packs that contain a specific OID
 * Uses the index on oid column for efficient lookup
 */
export async function findPacksContainingOid(database: DrizzleSqliteDODatabase, oid: string): Promise<string[]> {
	const rows = await database.select({ packKey: packObjects.packKey }).from(packObjects).where(eq(packObjects.oid, oid.toLowerCase()));
	return rows.map((r) => r.packKey);
}

/**
 * Get all OIDs for a specific pack
 * Uses the primary key index efficiently
 */
export async function getPackOids(database: DrizzleSqliteDODatabase, packKey: string): Promise<string[]> {
	const key = normalizePackKey(packKey);
	const rows = await database.select({ oid: packObjects.oid }).from(packObjects).where(eq(packObjects.packKey, key));
	return rows.map((r) => r.oid);
}

/**
 * Get a deterministic slice of OIDs for a specific pack with ordering.
 * Used by the unpacker to page through objects without storing the full list.
 */
export async function getPackOidsSlice(
	database: DrizzleSqliteDODatabase,
	packKey: string,
	offset: number,
	limit: number,
): Promise<string[]> {
	if (limit <= 0) return [];
	const key = normalizePackKey(packKey);
	const rows = await database
		.select({ oid: packObjects.oid })
		.from(packObjects)
		.where(eq(packObjects.packKey, key))
		.orderBy(packObjects.oid)
		.limit(limit)
		.offset(offset);
	return rows.map((r) => r.oid);
}

/**
 * Batch get OIDs for multiple packs
 * More efficient than multiple individual queries
 */
export async function getPackOidsBatch(database: DrizzleSqliteDODatabase, packKeys: string[]): Promise<Map<string, string[]>> {
	if (packKeys.length === 0) return new Map();
	// Prepare output map keyed by original input keys
	const result = new Map<string, string[]>();
	for (const orig of packKeys) result.set(orig, []);

	// Build normalized lookup set and mapping back to original keys
	const normToOriginals = new Map<string, string[]>();
	for (const orig of packKeys) {
		const norm = normalizePackKey(orig);
		const list = normToOriginals.get(norm) || [];
		list.push(orig);
		normToOriginals.set(norm, list);
	}
	const uniqueNorms = [...normToOriginals.keys()];

	// Cloudflare platform limits allow up to 100 bound parameters per query.
	// Since this IN() uses 1 param per key, keep a conservative batch size.
	const BATCH = 80;
	for (let index = 0; index < uniqueNorms.length; index += BATCH) {
		const batch = uniqueNorms.slice(index, index + BATCH);
		const rows = await database
			.select({ packKey: packObjects.packKey, oid: packObjects.oid })
			.from(packObjects)
			.where(inArray(packObjects.packKey, batch));

		// Group by normalized key
		const grouped = new Map<string, string[]>();
		for (const row of rows) {
			const array = grouped.get(row.packKey) || [];
			array.push(row.oid);
			grouped.set(row.packKey, array);
		}

		// Fan out to original keys that normalized to this key
		for (const norm of batch) {
			const array = grouped.get(norm) || [];
			const originals = normToOriginals.get(norm) || [];
			for (const orig of originals) {
				result.set(orig, [...array]);
			}
		}
	}

	return result;
}

/**
 * Insert pack membership rows for a pack key with chunking to respect param limits.
 */
export async function insertPackOids(database: DrizzleSqliteDODatabase, packKey: string, oids: readonly string[]): Promise<void> {
	if (!oids || oids.length === 0) return;
	const key = normalizePackKey(packKey);
	for (let index = 0; index < oids.length; index += SAFE_ROWS_2COL) {
		const part = oids.slice(index, index + SAFE_ROWS_2COL).map((oid) => ({ packKey: key, oid: String(oid).toLowerCase() }));
		if (part.length > 0) await database.insert(packObjects).values(part).onConflictDoNothing();
	}
}

/**
 * Delete pack membership data for a specific pack key.
 */
export async function deletePackObjects(database: DrizzleSqliteDODatabase, packKey: string): Promise<void> {
	const key = normalizePackKey(packKey);
	await database.delete(packObjects).where(eq(packObjects.packKey, key));
}

/**
 * Insert hydration coverage rows for a work id with chunking to respect param limits.
 */
export async function insertHydrCoverOids(database: DrizzleSqliteDODatabase, workId: string, oids: readonly string[]): Promise<void> {
	if (!oids || oids.length === 0) return;
	for (let index = 0; index < oids.length; index += SAFE_ROWS_2COL) {
		const part = oids.slice(index, index + SAFE_ROWS_2COL).map((oid) => ({ workId, oid: String(oid).toLowerCase() }));
		if (part.length > 0) await database.insert(hydrCover).values(part).onConflictDoNothing();
	}
}

/**
 * Insert hydration pending OIDs with chunking to respect param limits.
 */
export async function insertHydrPendingOids(
	database: DrizzleSqliteDODatabase,
	workId: string,
	kind: 'base' | 'loose',
	oids: readonly string[],
): Promise<void> {
	if (!oids || oids.length === 0) return;
	for (let index = 0; index < oids.length; index += SAFE_ROWS_3COL) {
		const part = oids.slice(index, index + SAFE_ROWS_3COL).map((oid) => ({ workId, kind, oid: String(oid).toLowerCase() }));
		if (part.length > 0) await database.insert(hydrPending).values(part).onConflictDoNothing();
	}
}

/**
 * Get pending OIDs of a specific kind for a work id.
 */
export async function getHydrPendingOids(
	database: DrizzleSqliteDODatabase,
	workId: string,
	kind: 'base' | 'loose',
	limit?: number,
): Promise<string[]> {
	const query = database
		.select({ oid: hydrPending.oid })
		.from(hydrPending)
		.where(and(eq(hydrPending.workId, workId), eq(hydrPending.kind, kind)))
		.orderBy(hydrPending.oid);

	if (limit && limit > 0) {
		query.limit(limit);
	}

	const rows = await query;
	return rows.map((r) => r.oid);
}

/**
 * Check whether hydr_cover has any rows for a given work id.
 * Useful as a cheap existence check to avoid repopulating coverage.
 */
export async function hasHydrCoverForWork(database: DrizzleSqliteDODatabase, workId: string): Promise<boolean> {
	const count = await database.$count(hydrCover, eq(hydrCover.workId, workId));
	return count > 0;
}

/**
 * Return the subset of input oids that are NOT present in hydr_cover for this work.
 * Performs batched IN-clause lookups to respect parameter limits.
 */
export async function filterUncoveredAgainstHydrCover(
	database: DrizzleSqliteDODatabase,
	workId: string,
	candidates: string[],
): Promise<string[]> {
	if (candidates.length === 0) return [];
	const BATCH = 80; // keep well under SQLite param limit (~100)
	const out: string[] = [];
	for (let index = 0; index < candidates.length; index += BATCH) {
		const part = candidates.slice(index, index + BATCH).map((x) => String(x).toLowerCase());
		const rows = await database
			.select({ oid: hydrCover.oid })
			.from(hydrCover)
			.where(and(eq(hydrCover.workId, workId), inArray(hydrCover.oid, part)));
		const covered = new Set(rows.map((r) => r.oid));
		for (const oid of part) if (!covered.has(oid)) out.push(oid);
	}
	return out;
}

/**
 * Get counts of pending OIDs by kind for a work id.
 */
export async function getHydrPendingCounts(database: DrizzleSqliteDODatabase, workId: string): Promise<{ bases: number; loose: number }> {
	const basesCount = await database.$count(hydrPending, and(eq(hydrPending.workId, workId), eq(hydrPending.kind, 'base')));
	const looseCount = await database.$count(hydrPending, and(eq(hydrPending.workId, workId), eq(hydrPending.kind, 'loose')));

	return {
		bases: basesCount,
		loose: looseCount,
	};
}

/**
 * Delete specific pending OIDs for a work id.
 */
export async function deleteHydrPendingOids(
	database: DrizzleSqliteDODatabase,
	workId: string,
	kind: 'base' | 'loose',
	oids: string[],
): Promise<void> {
	if (!oids || oids.length === 0) return;

	// Delete in batches to respect parameter limits
	for (let index = 0; index < oids.length; index += SAFE_ROWS_3COL) {
		const batch = oids.slice(index, index + SAFE_ROWS_3COL).map((o) => o.toLowerCase());
		await database
			.delete(hydrPending)
			.where(and(eq(hydrPending.workId, workId), eq(hydrPending.kind, kind), inArray(hydrPending.oid, batch)));
	}
}

/**
 * Clear all pending OIDs for a work id.
 */
export async function clearHydrPending(database: DrizzleSqliteDODatabase, workId: string): Promise<void> {
	await database.delete(hydrPending).where(eq(hydrPending.workId, workId));
}

/**
 * Clear hydration coverage for a specific work id.
 */
export async function clearHydrCover(database: DrizzleSqliteDODatabase, workId: string): Promise<void> {
	await database.delete(hydrCover).where(eq(hydrCover.workId, workId));
}
