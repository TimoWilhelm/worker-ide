/**
 * Data Access Layer for AgentRunner's SQLite tables.
 *
 * All database queries are centralized here. Functions accept the Drizzle
 * database instance as the first parameter, keeping the AgentRunner class
 * focused on business logic.
 *
 * The Drizzle `durable-sqlite` driver is synchronous — all query methods
 * return values directly (no Promises), matching Cloudflare DO's sync SQLite API.
 */

import { desc, eq } from 'drizzle-orm';

import { pendingChanges, runningSessions, sessions } from './schema';

import type { AgentDatabase } from './client';
import type { SessionRow } from './schema';

// =============================================================================
// Sessions
// =============================================================================

/**
 * Read a single session by ID.
 */
export function readSession(database: AgentDatabase, sessionId: string): SessionRow | undefined {
	const rows = database.select().from(sessions).where(eq(sessions.id, sessionId)).all();
	return rows[0];
}

/**
 * List all sessions with summary fields, ordered by creation time (newest first).
 */
export function listSessionSummaries(database: AgentDatabase): Array<{ id: string; title: string; createdAt: number }> {
	return database
		.select({
			id: sessions.id,
			title: sessions.title,
			createdAt: sessions.createdAt,
		})
		.from(sessions)
		.orderBy(desc(sessions.createdAt))
		.all();
}

/**
 * List all session IDs and creation times, ordered by creation time (newest first).
 * Used for pruning old sessions.
 */
export function listSessionIdsForPruning(database: AgentDatabase): Array<{ id: string; createdAt: number }> {
	return database
		.select({
			id: sessions.id,
			createdAt: sessions.createdAt,
		})
		.from(sessions)
		.orderBy(desc(sessions.createdAt))
		.all();
}

/**
 * Insert a new session with minimal fields (title, history).
 * Used when launching a brand-new agent run.
 */
export function insertSession(database: AgentDatabase, data: { id: string; title: string; createdAt: number; history: string }): void {
	database
		.insert(sessions)
		.values({
			id: data.id,
			title: data.title,
			titleGenerated: 0,
			createdAt: data.createdAt,
			history: data.history,
		})
		.run();
}

/**
 * Update only the history for an existing session.
 * Used when relaunching a run on an existing session.
 */
export function updateSessionHistory(database: AgentDatabase, sessionId: string, history: string): void {
	database.update(sessions).set({ history }).where(eq(sessions.id, sessionId)).run();
}

/**
 * Clear the revertedAt flag so persist callbacks from a new run are not blocked.
 */
export function clearSessionRevertedAt(database: AgentDatabase, sessionId: string): void {
	// eslint-disable-next-line unicorn/no-null -- SQL requires null to clear the column
	database.update(sessions).set({ revertedAt: null }).where(eq(sessions.id, sessionId)).run();
}

/**
 * Update the session title after AI generation.
 */
export function updateSessionTitle(database: AgentDatabase, sessionId: string, title: string, isAiGenerated: boolean): void {
	database
		.update(sessions)
		.set({ title, titleGenerated: isAiGenerated ? 1 : 0 })
		.where(eq(sessions.id, sessionId))
		.run();
}

/**
 * Update the terminal status and error message when a run finishes.
 */
export function updateSessionStatus(database: AgentDatabase, sessionId: string, status: string, errorMessage: string | undefined): void {
	database
		.update(sessions)
		.set({
			status,
			// eslint-disable-next-line unicorn/no-null -- SQL requires null to clear the column
			errorMessage: errorMessage ?? null,
		})
		.where(eq(sessions.id, sessionId))
		.run();
}

/**
 * Update session fields after a revert (truncate history, prune metadata).
 */
export function updateSessionForRevert(
	database: AgentDatabase,
	sessionId: string,
	data: {
		history: string;
		messageSnapshots: string | undefined;
		messageModes: string | undefined;
		contextTokensUsed: number | undefined;
		revertedAt: number;
	},
): void {
	database
		.update(sessions)
		.set({
			history: data.history,
			// eslint-disable-next-line unicorn/no-null -- SQL requires null to clear nullable columns
			messageSnapshots: data.messageSnapshots ?? null,
			// eslint-disable-next-line unicorn/no-null -- SQL requires null to clear nullable columns
			messageModes: data.messageModes ?? null,
			// eslint-disable-next-line unicorn/no-null -- SQL requires null to clear nullable columns
			contextTokensUsed: data.contextTokensUsed ?? null,
			revertedAt: data.revertedAt,
		})
		.where(eq(sessions.id, sessionId))
		.run();
}

/**
 * Persist a full session from the AI agent service.
 * Uses INSERT OR REPLACE to upsert all relevant fields.
 */
export function upsertSessionFromService(
	database: AgentDatabase,
	data: {
		id: string;
		title: string;
		titleGenerated: boolean;
		createdAt: number;
		history: string;
		messageSnapshots: string | undefined;
		messageModes: string | undefined;
		contextTokensUsed: number | undefined;
		toolMetadata: string | undefined;
		toolErrors: string | undefined;
	},
): void {
	database
		.insert(sessions)
		.values({
			id: data.id,
			title: data.title,
			titleGenerated: data.titleGenerated ? 1 : 0,
			createdAt: data.createdAt,
			history: data.history,
			// eslint-disable-next-line unicorn/no-null -- SQL requires null for nullable columns
			messageSnapshots: data.messageSnapshots ?? null,
			// eslint-disable-next-line unicorn/no-null -- SQL requires null for nullable columns
			messageModes: data.messageModes ?? null,
			// eslint-disable-next-line unicorn/no-null -- SQL requires null for nullable columns
			contextTokensUsed: data.contextTokensUsed ?? null,
			// eslint-disable-next-line unicorn/no-null -- SQL requires null for nullable columns
			toolMetadata: data.toolMetadata ?? null,
			// eslint-disable-next-line unicorn/no-null -- SQL requires null for nullable columns
			toolErrors: data.toolErrors ?? null,
		})
		.onConflictDoUpdate({
			target: sessions.id,
			set: {
				title: data.title,
				titleGenerated: data.titleGenerated ? 1 : 0,
				createdAt: data.createdAt,
				history: data.history,
				// eslint-disable-next-line unicorn/no-null -- SQL requires null for nullable columns
				messageSnapshots: data.messageSnapshots ?? null,
				// eslint-disable-next-line unicorn/no-null -- SQL requires null for nullable columns
				messageModes: data.messageModes ?? null,
				// eslint-disable-next-line unicorn/no-null -- SQL requires null for nullable columns
				contextTokensUsed: data.contextTokensUsed ?? null,
				// eslint-disable-next-line unicorn/no-null -- SQL requires null for nullable columns
				toolMetadata: data.toolMetadata ?? null,
				// eslint-disable-next-line unicorn/no-null -- SQL requires null for nullable columns
				toolErrors: data.toolErrors ?? null,
			},
		})
		.run();
}

/**
 * Delete a session by ID.
 */
export function deleteSession(database: AgentDatabase, sessionId: string): void {
	database.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

// =============================================================================
// Running Sessions
// =============================================================================

/**
 * Get all running session markers (for orphan recovery on wake).
 */
export function getAllRunningSessions(database: AgentDatabase): Array<{ sessionId: string; parameters: string }> {
	return database.select().from(runningSessions).all();
}

/**
 * Check if a specific session is marked as running.
 */
export function isSessionRunning(database: AgentDatabase, sessionId: string): boolean {
	const rows = database
		.select({ sessionId: runningSessions.sessionId })
		.from(runningSessions)
		.where(eq(runningSessions.sessionId, sessionId))
		.all();
	return rows.length > 0;
}

/**
 * Get all running session IDs.
 */
export function getRunningSessionIds(database: AgentDatabase): string[] {
	return database
		.select({ sessionId: runningSessions.sessionId })
		.from(runningSessions)
		.all()
		.map((row) => row.sessionId);
}

/**
 * Mark a session as running with its restart parameters.
 */
export function markSessionRunning(database: AgentDatabase, sessionId: string, parameters: string): void {
	database
		.insert(runningSessions)
		.values({ sessionId, parameters })
		.onConflictDoUpdate({
			target: runningSessions.sessionId,
			set: { parameters },
		})
		.run();
}

/**
 * Remove a running session marker (on completion, abort, or error).
 */
export function removeRunningSession(database: AgentDatabase, sessionId: string): void {
	database.delete(runningSessions).where(eq(runningSessions.sessionId, sessionId)).run();
}

/**
 * Remove all running session markers (abort all).
 */
export function removeAllRunningSessions(database: AgentDatabase): void {
	database.delete(runningSessions).run();
}

// =============================================================================
// Pending Changes
// =============================================================================

/**
 * Read the pending changes JSON blob. Returns an empty object if no row exists.
 */
export function readPendingChangesData(database: AgentDatabase): string {
	const rows = database.select({ data: pendingChanges.data }).from(pendingChanges).where(eq(pendingChanges.id, 1)).all();
	return rows[0]?.data ?? '{}';
}

/**
 * Write the pending changes JSON blob (upserts the single row).
 */
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

/**
 * Delete the pending changes row.
 */
export function deletePendingChanges(database: AgentDatabase): void {
	database.delete(pendingChanges).where(eq(pendingChanges.id, 1)).run();
}
