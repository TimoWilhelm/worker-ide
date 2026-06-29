/**
 * In-memory POSIX filesystem.
 *
 * The native plugins (vinext, `@vitejs/plugin-rsc`) read the project tree with
 * *synchronous* `node:fs` calls (`existsSync`, `readFileSync`, `readdirSync`,
 * …). Synchronous reads cannot cross an isolate boundary, so the plugin
 * pipeline runs inside an isolate whose `node:fs` is backed by this in-memory
 * filesystem, hydrated up-front from a snapshot of the project Workspace. Any
 * files the plugins write (route type definitions, manifests) land here too and
 * are read back out by the host.
 *
 * This class is pure and runtime-agnostic; the `node:fs` facade lives in
 * `./node-fs.ts`.
 */

export interface FileStats {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	size: number;
	mtimeMs: number;
}

export interface DirectoryEntry {
	name: string;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

interface Node {
	type: 'file' | 'directory';
	content?: Uint8Array;
	mtimeMs: number;
}

/** A POSIX `ENOENT`-style error carrying the `code` Node consumers branch on. */
export class FileSystemError extends Error {
	constructor(
		readonly code: 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EEXIST',
		readonly path: string,
		syscall: string,
	) {
		super(`${code}: ${syscall} '${path}'`);
		this.name = 'FileSystemError';
	}
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Collapse `.`/`..` segments and guarantee a single leading slash. */
export function normalizePosixPath(path: string): string {
	const isAbsolute = path.startsWith('/');
	const segments: string[] = [];
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (segments.length > 0 && segments.at(-1) !== '..') {
				segments.pop();
			} else if (!isAbsolute) {
				segments.push('..');
			}
			continue;
		}
		segments.push(segment);
	}
	return '/' + segments.join('/');
}

function parentOf(path: string): string {
	const normalized = normalizePosixPath(path);
	if (normalized === '/') {
		return '/';
	}
	const index = normalized.lastIndexOf('/');
	return index <= 0 ? '/' : normalized.slice(0, index);
}

function baseName(path: string): string {
	const normalized = normalizePosixPath(path);
	const index = normalized.lastIndexOf('/');
	return normalized.slice(index + 1);
}

export class MemoryFileSystem {
	private readonly nodes = new Map<string, Node>();

	constructor() {
		this.nodes.set('/', { type: 'directory', mtimeMs: Date.now() });
	}

	/** Replace the entire tree with a `path → content` snapshot. */
	static fromSnapshot(files: Record<string, string | Uint8Array>): MemoryFileSystem {
		const fileSystem = new MemoryFileSystem();
		for (const [path, content] of Object.entries(files)) {
			fileSystem.writeFile(path, content);
		}
		return fileSystem;
	}

	/** Export every file as a `path → string` map (directories omitted). */
	toSnapshot(): Record<string, string> {
		const snapshot: Record<string, string> = {};
		for (const [path, node] of this.nodes) {
			if (node.type === 'file' && node.content !== undefined) {
				snapshot[path] = textDecoder.decode(node.content);
			}
		}
		return snapshot;
	}

	exists(path: string): boolean {
		return this.nodes.has(normalizePosixPath(path));
	}

	private ensureDirectory(path: string): void {
		const normalized = normalizePosixPath(path);
		if (normalized === '/') {
			return;
		}
		this.ensureDirectory(parentOf(normalized));
		const existing = this.nodes.get(normalized);
		if (existing === undefined) {
			this.nodes.set(normalized, { type: 'directory', mtimeMs: Date.now() });
			return;
		}
		if (existing.type !== 'directory') {
			throw new FileSystemError('ENOTDIR', normalized, 'mkdir');
		}
	}

	mkdir(path: string, options?: { recursive?: boolean }): void {
		const normalized = normalizePosixPath(path);
		if (options?.recursive) {
			this.ensureDirectory(normalized);
			return;
		}
		const parent = this.nodes.get(parentOf(normalized));
		if (parent === undefined || parent.type !== 'directory') {
			throw new FileSystemError('ENOENT', normalized, 'mkdir');
		}
		if (this.nodes.has(normalized)) {
			throw new FileSystemError('EEXIST', normalized, 'mkdir');
		}
		this.nodes.set(normalized, { type: 'directory', mtimeMs: Date.now() });
	}

	writeFile(path: string, content: string | Uint8Array): void {
		const normalized = normalizePosixPath(path);
		this.ensureDirectory(parentOf(normalized));
		const existing = this.nodes.get(normalized);
		if (existing?.type === 'directory') {
			throw new FileSystemError('EISDIR', normalized, 'open');
		}
		const bytes = typeof content === 'string' ? textEncoder.encode(content) : content;
		this.nodes.set(normalized, { type: 'file', content: bytes, mtimeMs: Date.now() });
	}

	readFileBytes(path: string): Uint8Array {
		const node = this.nodes.get(normalizePosixPath(path));
		if (node === undefined) {
			throw new FileSystemError('ENOENT', path, 'open');
		}
		if (node.type === 'directory' || node.content === undefined) {
			throw new FileSystemError('EISDIR', path, 'read');
		}
		return node.content;
	}

	readFileText(path: string): string {
		return textDecoder.decode(this.readFileBytes(path));
	}

	readdir(path: string): DirectoryEntry[] {
		const normalized = normalizePosixPath(path);
		const directory = this.nodes.get(normalized);
		if (directory === undefined) {
			throw new FileSystemError('ENOENT', normalized, 'scandir');
		}
		if (directory.type !== 'directory') {
			throw new FileSystemError('ENOTDIR', normalized, 'scandir');
		}
		const prefix = normalized === '/' ? '/' : normalized + '/';
		const seen = new Map<string, Node>();
		for (const [childPath, node] of this.nodes) {
			if (childPath === normalized || !childPath.startsWith(prefix)) {
				continue;
			}
			const remainder = childPath.slice(prefix.length);
			const slashIndex = remainder.indexOf('/');
			const childName = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
			if (childName === '') {
				continue;
			}
			// A nested path implies an intermediate directory entry.
			const childNode = slashIndex === -1 ? node : { type: 'directory' as const, mtimeMs: node.mtimeMs };
			if (!seen.has(childName)) {
				seen.set(childName, childNode);
			}
		}
		return [...seen.entries()].map(([name, node]) => makeDirectoryEntry(name, node.type));
	}

	stat(path: string): FileStats {
		const node = this.nodes.get(normalizePosixPath(path));
		if (node === undefined) {
			throw new FileSystemError('ENOENT', path, 'stat');
		}
		return makeStats(node);
	}

	remove(path: string, options?: { recursive?: boolean }): void {
		const normalized = normalizePosixPath(path);
		if (!this.nodes.has(normalized)) {
			if (options?.recursive) {
				return;
			}
			throw new FileSystemError('ENOENT', normalized, 'unlink');
		}
		this.nodes.delete(normalized);
		if (options?.recursive) {
			const prefix = normalized + '/';
			for (const childPath of this.nodes.keys()) {
				if (childPath.startsWith(prefix)) {
					this.nodes.delete(childPath);
				}
			}
		}
	}

	/** Recursively copy a file or directory subtree. */
	copy(source: string, destination: string): void {
		const normalizedSource = normalizePosixPath(source);
		const node = this.nodes.get(normalizedSource);
		if (node === undefined) {
			throw new FileSystemError('ENOENT', normalizedSource, 'copyfile');
		}
		if (node.type === 'file') {
			this.writeFile(destination, node.content ?? new Uint8Array());
			return;
		}
		this.ensureDirectory(destination);
		const prefix = normalizedSource + '/';
		for (const [childPath, childNode] of this.nodes) {
			if (!childPath.startsWith(prefix) || childNode.type !== 'file' || childNode.content === undefined) {
				continue;
			}
			const relative = childPath.slice(prefix.length);
			this.writeFile(normalizePosixPath(destination + '/' + relative), childNode.content);
		}
	}

	baseName(path: string): string {
		return baseName(path);
	}
}

function makeStats(node: Node): FileStats {
	const isDirectory = node.type === 'directory';
	return {
		isFile: () => !isDirectory,
		isDirectory: () => isDirectory,
		isSymbolicLink: () => false,
		size: node.content?.byteLength ?? 0,
		mtimeMs: node.mtimeMs,
	};
}

function makeDirectoryEntry(name: string, type: 'file' | 'directory'): DirectoryEntry {
	const isDirectory = type === 'directory';
	return {
		name,
		isFile: () => !isDirectory,
		isDirectory: () => isDirectory,
		isSymbolicLink: () => false,
	};
}
