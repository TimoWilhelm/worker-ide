/**
 * `node:fs` facade over the in-memory project filesystem.
 *
 * Aliased to `node:fs` when bundling the native plugins so their synchronous
 * filesystem reads resolve against the hydrated {@link MemoryFileSystem} rather
 * than workerd's (absent) real filesystem. Only the surface the plugins
 * actually use at dev time is implemented; anything else throws a clear error
 * so gaps surface loudly instead of silently misbehaving.
 */
import { glob as globFiles } from './glob';
import { getProjectFileSystem } from './node-fs-bridge';

import type { GlobOptions } from './glob';
import type { DirectoryEntry, FileStats } from './memory-file-system';

export interface ReadOptions {
	encoding?: string | undefined;
}

export interface ReaddirOptions {
	withFileTypes?: boolean;
}

function resolveEncoding(options?: BufferEncoding | ReadOptions): string | undefined {
	if (typeof options === 'string') {
		return options;
	}
	return options?.encoding ?? undefined;
}

export function existsSync(path: string): boolean {
	try {
		return getProjectFileSystem().exists(path);
	} catch {
		return false;
	}
}

export function readFileSync(path: string, options?: BufferEncoding | ReadOptions): string | Uint8Array {
	const fileSystem = getProjectFileSystem();
	const encoding = resolveEncoding(options);
	return encoding === undefined ? fileSystem.readFileBytes(path) : fileSystem.readFileText(path);
}

export function writeFileSync(path: string, data: string | Uint8Array): void {
	getProjectFileSystem().writeFile(path, data);
}

export function readdirSync(path: string, options?: ReaddirOptions): string[] | DirectoryEntry[] {
	const entries = getProjectFileSystem().readdir(path);
	return options?.withFileTypes ? entries : entries.map((entry) => entry.name);
}

export function mkdirSync(path: string, options?: { recursive?: boolean }): void {
	getProjectFileSystem().mkdir(path, options);
}

export function statSync(path: string): FileStats {
	return getProjectFileSystem().stat(path);
}

export const lstatSync = statSync;

export function realpathSync(path: string): string {
	return path;
}

type RealpathCallback = (error: unknown, resolvedPath?: string) => void;

function realpathImpl(path: string, optionsOrCallback: unknown, maybeCallback?: RealpathCallback): void {
	// In-memory paths are already canonical; resolve to the input path.
	const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
	callback?.(undefined, path);
}

/** Callback-style `realpath`, including the `.native` variant Node exposes. */
export const realpath = Object.assign(realpathImpl, { native: realpathImpl });

export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
	getProjectFileSystem().remove(path, options);
}

export function unlinkSync(path: string): void {
	getProjectFileSystem().remove(path);
}

export function cpSync(source: string, destination: string): void {
	getProjectFileSystem().copy(source, destination);
}

export const promises = {
	async readFile(path: string, options?: BufferEncoding | ReadOptions): Promise<string | Uint8Array> {
		return readFileSync(path, options);
	},
	async writeFile(path: string, data: string | Uint8Array): Promise<void> {
		writeFileSync(path, data);
	},
	async readdir(path: string, options?: ReaddirOptions): Promise<string[] | DirectoryEntry[]> {
		return readdirSync(path, options);
	},
	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		mkdirSync(path, options);
	},
	async stat(path: string): Promise<FileStats> {
		return statSync(path);
	},
	async realpath(path: string): Promise<string> {
		return path;
	},
	async access(path: string): Promise<void> {
		if (!existsSync(path)) {
			throw new Error(`ENOENT: no such file or directory, access '${path}'`);
		}
	},
	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		rmSync(path, options);
	},
	async cp(source: string, destination: string): Promise<void> {
		cpSync(source, destination);
	},
	glob(pattern: string, options?: GlobOptions): AsyncGenerator<string> {
		return globFiles(getProjectFileSystem(), pattern, options ?? {});
	},
};

export default {
	existsSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	mkdirSync,
	statSync,
	lstatSync,
	realpathSync,
	realpath,
	rmSync,
	unlinkSync,
	cpSync,
	promises,
};
