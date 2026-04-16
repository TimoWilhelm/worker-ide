/**
 * Data access layer for AgentRunner's custom SQLite tables.
 */

import { eq } from 'drizzle-orm';

import { pendingChanges, sessionMetadata } from './schema';

import type { AgentDatabase } from './client';
import type { SessionMetadataInsert, SessionMetadataRow } from './schema';

export function readSessionMetadata(database: AgentDatabase, sessionId: string): SessionMetadataRow | undefined {
	const rows = database.select().from(sessionMetadata).where(eq(sessionMetadata.id, sessionId)).all();
	return rows[0];
}

export function upsertSessionMetadata(database: AgentDatabase, data: SessionMetadataInsert): void {
	database
		.insert(sessionMetadata)
		.values(data)
		.onConflictDoUpdate({
			target: sessionMetadata.id,
			set: {
				titleGenerated: data.titleGenerated,
				// eslint-disable-next-line unicorn/no-null -- SQL nullable column
				messageSnapshots: data.messageSnapshots ?? null,
				// eslint-disable-next-line unicorn/no-null -- SQL nullable column
				messageModes: data.messageModes ?? null,
				// eslint-disable-next-line unicorn/no-null -- SQL nullable column
				contextTokensUsed: data.contextTokensUsed ?? null,
				// eslint-disable-next-line unicorn/no-null -- SQL nullable column
				toolMetadata: data.toolMetadata ?? null,
				// eslint-disable-next-line unicorn/no-null -- SQL nullable column
				toolErrors: data.toolErrors ?? null,
				// eslint-disable-next-line unicorn/no-null -- SQL nullable column
				status: data.status ?? null,
				// eslint-disable-next-line unicorn/no-null -- SQL nullable column
				errorMessage: data.errorMessage ?? null,
			},
		})
		.run();
}

export function updateSessionMetadataTitleGenerated(database: AgentDatabase, sessionId: string, isGenerated: boolean): void {
	database
		.insert(sessionMetadata)
		.values({ id: sessionId, titleGenerated: isGenerated ? 1 : 0 })
		.onConflictDoUpdate({
			target: sessionMetadata.id,
			set: { titleGenerated: isGenerated ? 1 : 0 },
		})
		.run();
}

export function updateSessionMetadataStatus(
	database: AgentDatabase,
	sessionId: string,
	status: string,
	errorMessage: string | undefined,
): void {
	database
		.insert(sessionMetadata)
		.values({
			id: sessionId,
			titleGenerated: 0,
			status,
			// eslint-disable-next-line unicorn/no-null -- SQL nullable column
			errorMessage: errorMessage ?? null,
		})
		.onConflictDoUpdate({
			target: sessionMetadata.id,
			set: {
				status,
				// eslint-disable-next-line unicorn/no-null -- SQL nullable column
				errorMessage: errorMessage ?? null,
			},
		})
		.run();
}

export function deleteSessionMetadata(database: AgentDatabase, sessionId: string): void {
	database.delete(sessionMetadata).where(eq(sessionMetadata.id, sessionId)).run();
}

export function readPendingChangesData(database: AgentDatabase): string {
	const rows = database.select({ data: pendingChanges.data }).from(pendingChanges).where(eq(pendingChanges.id, 1)).all();
	return rows[0]?.data ?? '{}';
}

export function writePendingChangesData(database: AgentDatabase, data: string): void {
	database
		.insert(pendingChanges)
		.values({ id: 1, data })
		.onConflictDoUpdate({
			target: pendingChanges.id,
			set: { data },
		})
		.run();
}

export function deletePendingChanges(database: AgentDatabase): void {
	database.delete(pendingChanges).where(eq(pendingChanges.id, 1)).run();
}
