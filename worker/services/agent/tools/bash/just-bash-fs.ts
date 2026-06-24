import type { FileSystem as ShellFileSystem } from '@cloudflare/shell';
import type { FileContent, FsStat as JustBashStat, IFileSystem } from 'just-bash';

/** Default permission bits used when the workspace does not track a mode. */
const FILE_MODE = 0o10_0644;
const DIRECTORY_MODE = 0o04_0755;
const SYMLINK_MODE = 0o12_0777;

/**
 * Adapts a `@cloudflare/shell` {@link ShellFileSystem} to the just-bash
 * {@link IFileSystem} contract, bridging the small shape differences and
 * stubbing operations the workspace does not model.
 */
export class JustBashFs implements IFileSystem {
	constructor(private readonly fs: ShellFileSystem) {}

	readFile(path: string, _options?: unknown): Promise<string> {
		return this.fs.readFile(path);
	}

	readFileBuffer(path: string): Promise<Uint8Array> {
		return this.fs.readFileBytes(path);
	}

	async writeFile(path: string, content: FileContent, _options?: unknown): Promise<void> {
		if (typeof content === 'string') {
			await this.fs.writeFile(path, content);
			return;
		}
		await this.fs.writeFileBytes(path, content);
	}

	appendFile(path: string, content: FileContent, _options?: unknown): Promise<void> {
		return this.fs.appendFile(path, content);
	}

	exists(path: string): Promise<boolean> {
		return this.fs.exists(path);
	}

	async stat(path: string): Promise<JustBashStat> {
		return toJustBashStat(await this.fs.stat(path));
	}

	async lstat(path: string): Promise<JustBashStat> {
		return toJustBashStat(await this.fs.lstat(path));
	}

	mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		return this.fs.mkdir(path, options);
	}

	readdir(path: string): Promise<string[]> {
		return this.fs.readdir(path);
	}

	async readdirWithFileTypes(
		path: string,
	): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>> {
		const entries = await this.fs.readdirWithFileTypes(path);
		return entries.map((entry) => ({
			name: entry.name,
			isFile: entry.type === 'file',
			isDirectory: entry.type === 'directory',
			isSymbolicLink: entry.type === 'symlink',
		}));
	}

	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		return this.fs.rm(path, options);
	}

	cp(source: string, destination: string, options?: { recursive?: boolean }): Promise<void> {
		return this.fs.cp(source, destination, options);
	}

	mv(source: string, destination: string): Promise<void> {
		return this.fs.mv(source, destination);
	}

	resolvePath(base: string, path: string): string {
		return this.fs.resolvePath(base, path);
	}

	symlink(target: string, linkPath: string): Promise<void> {
		return this.fs.symlink(target, linkPath);
	}

	readlink(path: string): Promise<string> {
		return this.fs.readlink(path);
	}

	realpath(path: string): Promise<string> {
		return this.fs.realpath(path);
	}

	/** just-bash globs via readdir traversal, so no flat index is needed. */
	getAllPaths(): string[] {
		return [];
	}

	async chmod(_path: string, _mode: number): Promise<void> {
		// The workspace has no permission bits.
	}

	async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
		// The workspace has no mtime API.
	}

	async link(_existingPath: string, _newPath: string): Promise<void> {
		throw new Error('ENOSYS: hard links are not supported in the workspace filesystem');
	}
}

function toJustBashStat(stat: { type: 'file' | 'directory' | 'symlink'; size: number; mtime: Date; mode?: number }): JustBashStat {
	const defaultMode = stat.type === 'directory' ? DIRECTORY_MODE : stat.type === 'symlink' ? SYMLINK_MODE : FILE_MODE;
	return {
		isFile: stat.type === 'file',
		isDirectory: stat.type === 'directory',
		isSymbolicLink: stat.type === 'symlink',
		mode: stat.mode ?? defaultMode,
		size: stat.size,
		mtime: stat.mtime,
	};
}
