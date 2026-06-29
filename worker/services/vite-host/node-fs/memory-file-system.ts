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
 * The large, *constant* vendored sources (React/RSC `node_modules`, the vinext
 * runtime — together ~18 MB) are not copied into every build's filesystem.
 * Instead they are exposed through one or more shared, read-only
 * {@link VendoredLayer}s that the filesystem reads through (copy-on-write): the
 * overlay (`nodes`) holds only the project tree and build outputs, while reads
 * fall through to the base layers. This keeps a single copy of the vendored
 * source resident per isolate instead of re-encoding ~18 MB of bytes into each
 * build's filesystem.
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

/**
 * A shared, read-only set of files keyed by absolute path, with a precomputed
 * directory index. Built once per isolate from a constant vendored source and
 * referenced (never copied) by every {@link MemoryFileSystem} that needs it, so
 * the ~18 MB of vendored React/RSC/runtime source is resident a single time.
 */
export class VendoredLayer {
	/** `absolutePath -> contents`. */
	private readonly files: Map<string, string>;
	/** Every directory path implied by the files (always includes `/`). */
	private readonly directories = new Set<string>();
	/** `directory -> (childName -> type)`, for `readdir`. */
	private readonly children = new Map<string, Map<string, 'file' | 'directory'>>();
	/** Lazily-computed UTF-8 byte length per file (for `stat().size`). */
	private readonly sizes = new Map<string, number>();

	private constructor(files: Map<string, string>) {
		this.files = files;
		this.directories.add('/');
		for (const path of files.keys()) {
			this.indexAncestors(path, 'file');
		}
	}

	/**
	 * Build a layer from a `path -> contents` record. `pathPrefix` is prepended
	 * to each (relative) key, e.g. `/` to root the vendored `node_modules`.
	 */
	static fromRecord(record: Record<string, string>, pathPrefix = ''): VendoredLayer {
		const files = new Map<string, string>();
		for (const [relativePath, contents] of Object.entries(record)) {
			files.set(normalizePosixPath(`${pathPrefix}/${relativePath}`), contents);
		}
		return new VendoredLayer(files);
	}

	/** Register `path` and all of its ancestor directories in the index. */
	private indexAncestors(path: string, leafType: 'file' | 'directory'): void {
		let current = path;
		let type = leafType;
		while (current !== '/') {
			const parent = parentOf(current);
			let bucket = this.children.get(parent);
			if (bucket === undefined) {
				bucket = new Map();
				this.children.set(parent, bucket);
			}
			const name = baseName(current);
			if (!bucket.has(name)) {
				bucket.set(name, type);
			}
			if (type === 'file') {
				// Ancestors above the leaf are directories.
				type = 'directory';
			}
			if (this.directories.has(parent)) {
				break;
			}
			this.directories.add(parent);
			current = parent;
		}
	}

	hasFile(path: string): boolean {
		return this.files.has(path);
	}

	hasDirectory(path: string): boolean {
		return this.directories.has(path);
	}

	getFileText(path: string): string | undefined {
		return this.files.get(path);
	}

	sizeOf(path: string): number {
		const cached = this.sizes.get(path);
		if (cached !== undefined) {
			return cached;
		}
		const contents = this.files.get(path);
		const size = contents === undefined ? 0 : textEncoder.encode(contents).byteLength;
		this.sizes.set(path, size);
		return size;
	}

	/** Child entries directly under `directory` (empty if not a directory). */
	childrenOf(directory: string): Map<string, 'file' | 'directory'> {
		return this.children.get(directory) ?? new Map();
	}

	/** All file paths in the layer. */
	filePaths(): IterableIterator<string> {
		return this.files.keys();
	}
}

export class MemoryFileSystem {
	/** Copy-on-write overlay: project tree + build outputs (and dir markers). */
	private readonly nodes = new Map<string, Node>();
	/** Shared, read-only base layers (vendored sources), read through on miss. */
	private readonly baseLayers: VendoredLayer[] = [];
	/** Exact base paths shadowed by a delete. */
	private readonly tombstones = new Set<string>();
	/** Base directory prefixes removed recursively (hides all descendants). */
	private readonly removedPrefixes = new Set<string>();

	constructor() {
		this.nodes.set('/', { type: 'directory', mtimeMs: Date.now() });
	}

	/** Replace the entire overlay tree with a `path → content` snapshot. */
	static fromSnapshot(files: Record<string, string | Uint8Array>): MemoryFileSystem {
		const fileSystem = new MemoryFileSystem();
		for (const [path, content] of Object.entries(files)) {
			fileSystem.writeFile(path, content);
		}
		return fileSystem;
	}

	/**
	 * Register a shared, read-only base layer. Reads fall through to base layers
	 * when the overlay has no entry; the layer's contents are never copied.
	 */
	addBaseLayer(layer: VendoredLayer): void {
		this.baseLayers.push(layer);
	}

	/** Whether `path` is hidden from the base layers by a delete. */
	private isHiddenInBase(path: string): boolean {
		if (this.tombstones.has(path)) {
			return true;
		}
		for (const prefix of this.removedPrefixes) {
			if (path === prefix || path.startsWith(prefix + '/')) {
				return true;
			}
		}
		return false;
	}

	private baseFile(path: string): string | undefined {
		if (this.isHiddenInBase(path)) {
			return undefined;
		}
		for (const layer of this.baseLayers) {
			const contents = layer.getFileText(path);
			if (contents !== undefined) {
				return contents;
			}
		}
		return undefined;
	}

	private baseHasDirectory(path: string): boolean {
		if (this.isHiddenInBase(path)) {
			return false;
		}
		return this.baseLayers.some((layer) => layer.hasDirectory(path));
	}

	/** Export every overlay file as a `path → string` map (directories omitted). */
	toSnapshot(): Record<string, string> {
		const snapshot: Record<string, string> = {};
		for (const [path, node] of this.nodes) {
			if (node.type === 'file' && node.content !== undefined) {
				snapshot[path] = textDecoder.decode(node.content);
			}
		}
		return snapshot;
	}

	/** All file paths visible in the filesystem (overlay shadows base). */
	filePaths(): string[] {
		const paths = new Set<string>();
		for (const [path, node] of this.nodes) {
			if (node.type === 'file') {
				paths.add(path);
			}
		}
		for (const layer of this.baseLayers) {
			for (const path of layer.filePaths()) {
				if (!paths.has(path) && !this.isHiddenInBase(path)) {
					paths.add(path);
				}
			}
		}
		return [...paths];
	}

	/** Overlay files (path → contents) beneath `prefix` (e.g. a build outDir). */
	readFilesUnder(prefix: string): Record<string, string> {
		const normalized = prefix.replace(/\/$/, '');
		const directoryPrefix = `${normalized}/`;
		const output: Record<string, string> = {};
		for (const [path, node] of this.nodes) {
			if (node.type === 'file' && node.content !== undefined && path.startsWith(directoryPrefix)) {
				output[path.slice(directoryPrefix.length)] = textDecoder.decode(node.content);
			}
		}
		return output;
	}

	exists(path: string): boolean {
		const normalized = normalizePosixPath(path);
		if (this.nodes.has(normalized)) {
			return true;
		}
		if (this.isHiddenInBase(normalized)) {
			return false;
		}
		return this.baseFile(normalized) !== undefined || this.baseHasDirectory(normalized);
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
		// An overlay write shadows the base; clear any tombstone for this path.
		this.tombstones.delete(normalized);
		const bytes = typeof content === 'string' ? textEncoder.encode(content) : content;
		this.nodes.set(normalized, { type: 'file', content: bytes, mtimeMs: Date.now() });
	}

	readFileBytes(path: string): Uint8Array {
		const normalized = normalizePosixPath(path);
		const node = this.nodes.get(normalized);
		if (node !== undefined) {
			if (node.type === 'directory' || node.content === undefined) {
				throw new FileSystemError('EISDIR', path, 'read');
			}
			return node.content;
		}
		const baseContents = this.baseFile(normalized);
		if (baseContents !== undefined) {
			return textEncoder.encode(baseContents);
		}
		if (this.baseHasDirectory(normalized)) {
			throw new FileSystemError('EISDIR', path, 'read');
		}
		throw new FileSystemError('ENOENT', path, 'open');
	}

	readFileText(path: string): string {
		const normalized = normalizePosixPath(path);
		const node = this.nodes.get(normalized);
		if (node !== undefined) {
			if (node.type === 'directory' || node.content === undefined) {
				throw new FileSystemError('EISDIR', path, 'read');
			}
			return textDecoder.decode(node.content);
		}
		const baseContents = this.baseFile(normalized);
		if (baseContents !== undefined) {
			return baseContents;
		}
		if (this.baseHasDirectory(normalized)) {
			throw new FileSystemError('EISDIR', path, 'read');
		}
		throw new FileSystemError('ENOENT', path, 'open');
	}

	readdir(path: string): DirectoryEntry[] {
		const normalized = normalizePosixPath(path);
		const overlayNode = this.nodes.get(normalized);
		if (overlayNode !== undefined && overlayNode.type !== 'directory') {
			throw new FileSystemError('ENOTDIR', normalized, 'scandir');
		}
		const isBaseDirectory = this.baseHasDirectory(normalized);
		if (overlayNode === undefined && !isBaseDirectory) {
			throw new FileSystemError('ENOENT', normalized, 'scandir');
		}

		const entries = new Map<string, 'file' | 'directory'>();
		// Base entries first; overlay entries override.
		if (isBaseDirectory) {
			for (const layer of this.baseLayers) {
				for (const [name, type] of layer.childrenOf(normalized)) {
					const childPath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;
					if (!this.isHiddenInBase(childPath)) {
						entries.set(name, type);
					}
				}
			}
		}
		const prefix = normalized === '/' ? '/' : normalized + '/';
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
			entries.set(childName, slashIndex === -1 ? node.type : 'directory');
		}
		return [...entries.entries()].map(([name, type]) => makeDirectoryEntry(name, type));
	}

	stat(path: string): FileStats {
		const normalized = normalizePosixPath(path);
		const node = this.nodes.get(normalized);
		if (node !== undefined) {
			return makeStats(node);
		}
		if (!this.isHiddenInBase(normalized)) {
			for (const layer of this.baseLayers) {
				if (layer.hasFile(normalized)) {
					return makeStatsFromValues(false, layer.sizeOf(normalized));
				}
			}
			if (this.baseHasDirectory(normalized)) {
				return makeStatsFromValues(true, 0);
			}
		}
		throw new FileSystemError('ENOENT', path, 'stat');
	}

	remove(path: string, options?: { recursive?: boolean }): void {
		const normalized = normalizePosixPath(path);
		const existsInOverlay = this.nodes.has(normalized);
		const existsInBase = this.baseFile(normalized) !== undefined || this.baseHasDirectory(normalized);
		if (!existsInOverlay && !existsInBase) {
			if (options?.recursive) {
				return;
			}
			throw new FileSystemError('ENOENT', normalized, 'unlink');
		}

		this.nodes.delete(normalized);
		// Shadow the base entry (if any) so the delete is observed through reads.
		this.tombstones.add(normalized);
		if (options?.recursive) {
			this.removedPrefixes.add(normalized);
			const prefix = normalized + '/';
			for (const childPath of this.nodes.keys()) {
				if (childPath.startsWith(prefix)) {
					this.nodes.delete(childPath);
				}
			}
		}
	}

	/** Recursively copy a file or directory subtree (into the overlay). */
	copy(source: string, destination: string): void {
		const normalizedSource = normalizePosixPath(source);
		if (this.exists(normalizedSource) && this.stat(normalizedSource).isFile()) {
			this.writeFile(destination, this.readFileBytes(normalizedSource));
			return;
		}
		if (!this.exists(normalizedSource)) {
			throw new FileSystemError('ENOENT', normalizedSource, 'copyfile');
		}
		this.ensureDirectory(destination);
		const prefix = normalizedSource + '/';
		for (const childPath of this.filePaths()) {
			if (!childPath.startsWith(prefix)) {
				continue;
			}
			const relative = childPath.slice(prefix.length);
			this.writeFile(normalizePosixPath(destination + '/' + relative), this.readFileBytes(childPath));
		}
	}

	baseName(path: string): string {
		return baseName(path);
	}
}

function makeStats(node: Node): FileStats {
	return makeStatsFromValues(node.type === 'directory', node.content?.byteLength ?? 0, node.mtimeMs);
}

function makeStatsFromValues(isDirectory: boolean, size: number, mtimeMs = 0): FileStats {
	return {
		isFile: () => !isDirectory,
		isDirectory: () => isDirectory,
		isSymbolicLink: () => false,
		size,
		mtimeMs,
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
