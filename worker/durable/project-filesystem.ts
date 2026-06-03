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
	// File writes
	// =========================================================================

	async writeFileContent(path: string, content: string): Promise<void> {
		await this.writeFileContentInternal(path, content);
	}

	async writeFiles(files: ReadonlyArray<{ path: string; content: string }>): Promise<void> {
		for (const file of files) {
			await this.writeFileContentInternal(file.path, file.content);
		}
	}

	private async writeFileContentInternal(path: string, content: string): Promise<void> {
		const directory = path.slice(0, path.lastIndexOf('/'));
		await this.mkdir(directory === '' ? '/' : directory, { recursive: true });

		const bytes = new TextEncoder().encode(content);
		const stream = await this.createWriteStream(path, { flags: 'w' });
		const writer = stream.getWriter();
		try {
			if (bytes.length > 0) {
				await writer.write(bytes);
			}
			await writer.close();
		} catch (error) {
			try {
				await writer.abort(error);
			} catch (abortError) {
				console.error('Failed to abort file writer:', abortError);
			}
			throw error;
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
	getStagedPaths(): string[] {
		return this.ctx.storage.kv.get<string[]>('stagedPaths') ?? [];
	}
	setStagedPaths(paths: string[]): void {
		this.ctx.storage.kv.put('stagedPaths', paths);
	}
	addStagedPaths(paths: string[]): void {
		const existing = this.getStagedPaths();
		const merged = [...new Set([...existing, ...paths])];
		this.ctx.storage.kv.put('stagedPaths', merged);
	}
	removeStagedPaths(paths: string[]): void {
		const existing = this.getStagedPaths();
		const removeSet = new Set(paths);
		const filtered = existing.filter((path) => !removeSet.has(path));
		this.ctx.storage.kv.put('stagedPaths', filtered);
	}
	clearStagedPaths(): void {
		this.ctx.storage.kv.delete('stagedPaths');
	}
}
