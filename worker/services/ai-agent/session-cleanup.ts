/**
 * Session artifact cleanup for the AI agent.
 *
 * Cleans up filesystem artifacts left behind by pruned sessions:
 * - `.agent/sessions/{id}/` — filetime data and debug logs
 * - `.agent/todo/{id}.json` — per-session TODO files
 * - `.agent/plans/{id}.md` — per-session plan files (from plan_update tool)
 * - `.agent/snapshots/{id}/` — snapshots owned by pruned sessions
 *   (preserved if still referenced by surviving pending changes)
 * - `.agent/plans/{timestamp}-plan.md` — global plan-mode plans (capped)
 *
 * All functions expect to run inside a `withMounts()` context so that
 * `node:fs/promises` operations are routed to the virtual filesystem.
 */

import fs from 'node:fs/promises';

import { clearSession } from './file-time';

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum number of timestamped plan-mode plans to keep.
 * These are global (not session-scoped) and accumulate one per plan-mode run.
 */
const MAX_TIMESTAMP_PLANS = 10;

// =============================================================================
// Public API
// =============================================================================

/**
 * Remove filesystem artifacts for a set of pruned session IDs.
 *
 * @param projectRoot - The project root path (e.g. `/project`)
 * @param prunedSessionIds - Session IDs that have been removed from KV storage
 * @param survivingSnapshotIds - Snapshot IDs still referenced by pending changes
 *   from surviving sessions. These are never deleted even if owned by a pruned session.
 */
export async function cleanupSessionArtifacts(
	projectRoot: string,
	prunedSessionIds: Set<string>,
	survivingSnapshotIds: Set<string>,
): Promise<void> {
	// Evict file-time entries from the in-memory promise cache (synchronous).
	for (const sessionId of prunedSessionIds) {
		clearSession(projectRoot, sessionId);
	}

	const results = await Promise.allSettled([
		// Clean up per-session directories (.agent/sessions/{id}/)
		cleanupSessionDirectories(projectRoot, prunedSessionIds),
		// Clean up per-session todo files (.agent/todo/{id}.json)
		cleanupSessionTodos(projectRoot, prunedSessionIds),
		// Clean up per-session plan files (.agent/plans/{id}.md)
		cleanupSessionPlans(projectRoot, prunedSessionIds),
		// Clean up orphaned snapshots owned by pruned sessions
		cleanupOrphanedSnapshots(projectRoot, prunedSessionIds, survivingSnapshotIds),
	]);

	for (const result of results) {
		if (result.status === 'rejected') {
			console.error('[session-cleanup] Artifact cleanup error:', result.reason);
		}
	}
}

/**
 * Prune old timestamped plan-mode plan files, keeping only the most recent.
 * These files are named `{timestamp}-plan.md` and are not session-scoped.
 *
 * @param projectRoot - The project root path (e.g. `/project`)
 */
export async function cleanupTimestampPlans(projectRoot: string): Promise<void> {
	const plansDirectory = `${projectRoot}/.agent/plans`;

	try {
		const entries = await fs.readdir(plansDirectory);
		const timestampPlans = entries.filter((entry) => entry.endsWith('-plan.md')).toSorted();

		if (timestampPlans.length <= MAX_TIMESTAMP_PLANS) return;

		const toRemove = timestampPlans.slice(0, timestampPlans.length - MAX_TIMESTAMP_PLANS);
		for (const file of toRemove) {
			try {
				await fs.unlink(`${plansDirectory}/${file}`);
			} catch {
				// Non-fatal
			}
		}
	} catch {
		// Directory may not exist
	}
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Remove `.agent/sessions/{id}/` directories (filetime.json + debug-logs/).
 */
async function cleanupSessionDirectories(projectRoot: string, sessionIds: Set<string>): Promise<void> {
	const sessionsDirectory = `${projectRoot}/.agent/sessions`;

	for (const sessionId of sessionIds) {
		try {
			await deleteDirectoryRecursive(`${sessionsDirectory}/${sessionId}`);
		} catch {
			// Non-fatal
		}
	}
}

/**
 * Remove `.agent/todo/{id}.json` files.
 */
async function cleanupSessionTodos(projectRoot: string, sessionIds: Set<string>): Promise<void> {
	const todoDirectory = `${projectRoot}/.agent/todo`;

	for (const sessionId of sessionIds) {
		try {
			await fs.unlink(`${todoDirectory}/${sessionId}.json`);
		} catch {
			// File may not exist
		}
	}
}

/**
 * Remove `.agent/plans/{id}.md` files (from plan_update tool).
 */
async function cleanupSessionPlans(projectRoot: string, sessionIds: Set<string>): Promise<void> {
	const plansDirectory = `${projectRoot}/.agent/plans`;

	for (const sessionId of sessionIds) {
		try {
			await fs.unlink(`${plansDirectory}/${sessionId}.md`);
		} catch {
			// File may not exist
		}
	}
}

/**
 * Remove snapshots whose metadata.json `sessionId` matches a pruned session,
 * unless the snapshot ID is in the surviving set (still referenced by
 * pending changes from surviving sessions).
 */
async function cleanupOrphanedSnapshots(
	projectRoot: string,
	prunedSessionIds: Set<string>,
	survivingSnapshotIds: Set<string>,
): Promise<void> {
	const snapshotsDirectory = `${projectRoot}/.agent/snapshots`;

	let entries: string[];
	try {
		entries = await fs.readdir(snapshotsDirectory);
	} catch {
		return; // Directory doesn't exist
	}

	for (const entry of entries) {
		// Never delete snapshots still referenced by surviving pending changes
		if (survivingSnapshotIds.has(entry)) continue;

		try {
			const metadataPath = `${snapshotsDirectory}/${entry}/metadata.json`;
			const raw = await fs.readFile(metadataPath, 'utf8');
			const metadata: { sessionId?: string } = JSON.parse(raw);

			if (metadata.sessionId && prunedSessionIds.has(metadata.sessionId)) {
				await deleteDirectoryRecursive(`${snapshotsDirectory}/${entry}`);
			}
		} catch {
			// Malformed or missing metadata — skip, don't delete
		}
	}
}

/**
 * Recursively delete a directory and all its contents.
 */
async function deleteDirectoryRecursive(directoryPath: string): Promise<void> {
	try {
		const entries = await fs.readdir(directoryPath, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = `${directoryPath}/${entry.name}`;
			await (entry.isDirectory() ? deleteDirectoryRecursive(fullPath) : fs.unlink(fullPath));
		}
		await fs.rmdir(directoryPath);
	} catch {
		// Non-fatal
	}
}
