import { DurableObjectFilesystem } from 'durable-object-fs';

/**
 * Extended DurableObjectFilesystem that adds project lifecycle helpers
 * and staged path tracking for git operations.
 *
 * The working tree (files the editor/agent sees) lives in this DO's SQLite database.
 * Git storage (objects, refs, packs) is handled by the git auxiliary worker's RepoDO.
 * The staged paths are tracked here to support the IDE's staging UI.
 *
 * Project lifecycle (creation, soft-delete, permanent purge) is managed at the
 * D1 layer. This class does not set alarms or auto-expire.
 */
export class ProjectFilesystem extends DurableObjectFilesystem {
	// =========================================================================
	// Project existence check
	// =========================================================================

	/**
	 * Check if this project has been initialized, without creating any state.
	 *
	 * Queries SQLite directly for the `.initialized` sentinel file.
	 * If the filesystem schema hasn't been created yet (the DO was never
	 * used), this returns false without creating any tables or rows.
	 */
	projectExists(): boolean {
		try {
			// Check if the entries table exists — if not, the DO was never used
			const tableCheck = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entries' LIMIT 1");
			if ([...tableCheck].length === 0) {
				return false;
			}

			// Check if the .initialized sentinel file exists.
			// Paths in the DO's SQLite are relative to the mount root (no /project prefix).
			const result = this.ctx.storage.sql.exec("SELECT 1 FROM entries WHERE path = '/.initialized' AND type = 'file' LIMIT 1");
			return [...result].length > 0;
		} catch {
			return false;
		}
	}

	// =========================================================================
	// Storage destruction
	// =========================================================================

	/**
	 * Immediately destroy all storage in this Durable Object.
	 * Called via RPC from the scheduled purge job when a soft-deleted project's
	 * retention period has expired.
	 */
	async destroyStorage(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		console.log(`Project storage destroyed at ${new Date().toISOString()}`);
	}

	// =========================================================================
	// Staged Paths — Tracking which files are staged for the next commit
	// =========================================================================

	/**
	 * Get the list of currently staged file paths.
	 */
	async getStagedPaths(): Promise<string[]> {
		const value = await this.ctx.storage.get<string[]>('stagedPaths');
		return value ?? [];
	}

	/**
	 * Set the full list of staged file paths (replaces any existing).
	 */
	async setStagedPaths(paths: string[]): Promise<void> {
		await this.ctx.storage.put('stagedPaths', paths);
	}

	/**
	 * Add paths to the staged set (merge with existing).
	 */
	async addStagedPaths(paths: string[]): Promise<void> {
		const existing = await this.getStagedPaths();
		const merged = [...new Set([...existing, ...paths])];
		await this.ctx.storage.put('stagedPaths', merged);
	}

	/**
	 * Remove paths from the staged set.
	 */
	async removeStagedPaths(paths: string[]): Promise<void> {
		const existing = await this.getStagedPaths();
		const removeSet = new Set(paths);
		const filtered = existing.filter((path) => !removeSet.has(path));
		await this.ctx.storage.put('stagedPaths', filtered);
	}

	/**
	 * Clear all staged paths.
	 */
	async clearStagedPaths(): Promise<void> {
		await this.ctx.storage.delete('stagedPaths');
	}
}
