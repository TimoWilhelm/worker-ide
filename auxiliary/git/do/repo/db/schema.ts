import { sql } from 'drizzle-orm';
import { sqliteTable, text, primaryKey, index, check } from 'drizzle-orm/sqlite-core';

// Table: pack_objects
// Stores exact membership of OIDs per pack key.
// NOTE: pack_key stores only the pack basename (e.g., "pack-12345.pack"),
// not the full R2 path. See DAL normalizePackKey() and migration that
// rewrites legacy full paths to basenames to reduce storage usage.
export const packObjects = sqliteTable(
	'pack_objects',
	{
		packKey: text('pack_key').notNull(),
		oid: text('oid').notNull(),
	},
	(t) => [primaryKey({ columns: [t.packKey, t.oid], name: 'pack_objects_pk' }), index('idx_pack_objects_oid').on(t.oid)],
);

// Table: hydr_cover
// Stores coverage set per hydration work id
export const hydrCover = sqliteTable(
	'hydr_cover',
	{
		workId: text('work_id').notNull(),
		oid: text('oid').notNull(),
	},
	(t) => [primaryKey({ columns: [t.workId, t.oid], name: 'hydr_cover_pk' }), index('idx_hydr_cover_oid').on(t.oid)],
);

// Table: hydr_pending
// Stores pending OIDs to be hydrated per work id
export const hydrPending = sqliteTable(
	'hydr_pending',
	{
		workId: text('work_id').notNull(),
		kind: text('kind').notNull(), // 'base' or 'loose'
		oid: text('oid').notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.workId, t.kind, t.oid], name: 'hydr_pending_pk' }),
		index('idx_hydr_pending_work_kind').on(t.workId, t.kind),
		check('chk_hydr_pending_kind', sql`"kind" IN ('base','loose')`),
	],
);

export type PackObjectsRow = typeof packObjects.$inferSelect;
export type HydrCoverRow = typeof hydrCover.$inferSelect;
export type HydrPendingRow = typeof hydrPending.$inferSelect;
