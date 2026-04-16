/**
 * Drizzle ORM schema definitions for AgentRunner's custom tables.
 *
 * Conversation history now lives in the Agents Session API tables.
 * This schema only stores IDE-specific metadata and extension source.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * IDE-specific per-session metadata that is not modeled by SessionManager.
 */
export const sessionMetadata = sqliteTable('session_metadata', {
	id: text('id').primaryKey(),
	titleGenerated: integer('title_generated').notNull().default(0),
	messageSnapshots: text('message_snapshots'),
	messageModes: text('message_modes'),
	contextTokensUsed: integer('context_tokens_used'),
	toolMetadata: text('tool_metadata'),
	toolErrors: text('tool_errors'),
	status: text('status'),
	errorMessage: text('error_message'),
});

/**
 * Project-level pending file changes. Uses a single-row pattern (id=1)
 * with a JSON blob storing the full change map.
 */
export const pendingChanges = sqliteTable('pending_changes', {
	id: integer('id').primaryKey().default(1),
	data: text('data').notNull().default('{}'),
});

export type SessionMetadataRow = typeof sessionMetadata.$inferSelect;
export type SessionMetadataInsert = typeof sessionMetadata.$inferInsert;
export type PendingChangesRow = typeof pendingChanges.$inferSelect;
