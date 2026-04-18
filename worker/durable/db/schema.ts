import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const sessionMetadata = sqliteTable('session_metadata', {
	id: text('id').primaryKey(),
	titleGenerated: integer('title_generated').notNull().default(0),
	contextTokensUsed: integer('context_tokens_used'),
	toolMetadata: text('tool_metadata'),
	toolErrors: text('tool_errors'),
	status: text('status'),
	errorMessage: text('error_message'),
	stopRequested: integer('stop_requested').notNull().default(0),
});

/**
 * Project-level pending file changes. Uses a single-row pattern (id=1)
 * with a JSON blob storing the full change map.
 */
export const pendingChanges = sqliteTable('pending_changes', {
	id: integer('id').primaryKey().default(1),
	data: text('data').notNull().default('{}'),
});

export const sessionMessageMetadata = sqliteTable(
	'session_message_metadata',
	{
		sessionId: text('session_id').notNull(),
		messageId: text('message_id').notNull(),
		requestMode: text('request_mode'),
		requestModel: text('request_model'),
		requestState: text('request_state'),
		snapshotId: text('snapshot_id'),
	},
	(table) => ({
		primaryKey: primaryKey({ columns: [table.sessionId, table.messageId] }),
	}),
);

export type SessionMetadataRow = typeof sessionMetadata.$inferSelect;
export type SessionMetadataInsert = typeof sessionMetadata.$inferInsert;
export type PendingChangesRow = typeof pendingChanges.$inferSelect;
export type SessionMessageMetadataRow = typeof sessionMessageMetadata.$inferSelect;
export type SessionMessageMetadataInsert = typeof sessionMessageMetadata.$inferInsert;
