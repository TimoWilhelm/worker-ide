/**
 * Drizzle ORM schema definitions for AgentRunner's custom tables.
 *
 * These tables store AI session data, running session markers for eviction
 * recovery, and pending file changes. The Agent SDK's own internal tables
 * (state, scheduling, etc.) are managed separately by the SDK itself.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// =============================================================================
// Tables
// =============================================================================

/**
 * AI chat sessions. Each row represents a conversation with its full message
 * history and associated metadata (snapshots, tool info, modes, etc.).
 *
 * JSON-serialized fields: history, messageSnapshots, messageModes,
 * toolMetadata, toolErrors.
 */
export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	title: text('title').notNull().default(''),
	titleGenerated: integer('title_generated').notNull().default(0),
	createdAt: integer('created_at').notNull(),
	history: text('history').notNull().default('[]'),
	messageSnapshots: text('message_snapshots'),
	messageModes: text('message_modes'),
	contextTokensUsed: integer('context_tokens_used'),
	revertedAt: integer('reverted_at'),
	toolMetadata: text('tool_metadata'),
	toolErrors: text('tool_errors'),
	status: text('status'),
	errorMessage: text('error_message'),
});

/**
 * Durable marker for sessions that are actively running. Persists the full
 * start parameters so the agent loop can be restarted after DO eviction.
 *
 * Rows are inserted before launching a loop and deleted on completion/abort.
 */
export const runningSessions = sqliteTable('running_sessions', {
	sessionId: text('session_id').primaryKey(),
	parameters: text('parameters').notNull(),
});

/**
 * Project-level pending file changes. Uses a single-row pattern (id=1)
 * with a JSON blob storing the full change map.
 */
export const pendingChanges = sqliteTable('pending_changes', {
	id: integer('id').primaryKey().default(1),
	data: text('data').notNull().default('{}'),
});

// =============================================================================
// Inferred Types
// =============================================================================

export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type RunningSessionRow = typeof runningSessions.$inferSelect;
export type PendingChangesRow = typeof pendingChanges.$inferSelect;
