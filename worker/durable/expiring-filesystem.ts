import { DurableObjectFilesystem } from 'durable-object-fs';

import { PROJECT_EXPIRATION_DAYS } from '@shared/constants';

/**
 * Project expiration duration in milliseconds.
 * Projects unused for this duration will be automatically deleted.
 */
const PROJECT_EXPIRATION_MS = PROJECT_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Extended DurableObjectFilesystem that adds automatic expiration for unused projects
 * and staged path tracking for git operations.
 *
 * The working tree (files the editor/agent sees) lives in this DO's SQLite database.
 * Git storage (objects, refs, packs) is handled by the git auxiliary worker's RepoDO.
 * The staged paths are tracked here to support the IDE's staging UI.
 */
export class ExpiringFilesystem extends DurableObjectFilesystem {
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
	// Expiration
	// =========================================================================

	/**
	 * Refresh the expiration alarm. This should be called on every project access.
	 * Sets an alarm for PROJECT_EXPIRATION_MS from now.
	 */
	async refreshExpiration(): Promise<void> {
		await this.ctx.storage.deleteAlarm();

		const expirationTime = Date.now() + PROJECT_EXPIRATION_MS;
		await this.ctx.storage.setAlarm(expirationTime);
	}

	/**
	 * Get the current expiration time, if set.
	 * @returns The expiration timestamp in milliseconds, or null if no alarm is set
	 */
	async getExpirationTime(): Promise<number | null> {
		return await this.ctx.storage.getAlarm();
	}

	/**
	 * Alarm handler - called when the expiration alarm fires.
	 * Deletes all data in this Durable Object, effectively removing the project.
	 */
	async alarm(): Promise<void> {
		// Delete all data in this Durable Object
		await this.ctx.storage.deleteAll();
		console.log(`Project expired and deleted at ${new Date().toISOString()}`);
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
