import { deflate } from '@git/common/compression';
import { bytesToHex } from '@git/common/hex';
import { createLogger } from '@git/common/logger';
import { asTypedStorage, objKey } from '@git/do/repo/repo-state';
import { r2LooseKey, packIndexKey } from '@git/keys';
import * as git from 'isomorphic-git';

import { createLooseLoader } from './loose-loader';

import type { RepoStateSchema } from '@git/do/repo/repo-state';

/**
 * Index a pack file quickly without unpacking objects.
 * Returns the list of OIDs directly stored in the pack.
 *
 * @param packBytes Raw `.pack` bytes provided by the client
 * @param env Worker environment (for writing `.idx` to R2)
 * @param packKey R2 key under which the `.pack` is stored (used to derive `.idx` key)
 * @param doState Optional DO state for checking existing objects (needed for thin packs)
 * @param prefix Optional DO prefix for R2 keys
 * @returns Array of object IDs contained in the pack
 */
export async function indexPackOnly(
	packBytes: Uint8Array,
	environment: GitWorkerEnvironment,
	packKey: string,
	doState?: DurableObjectState,
	prefix?: string,
): Promise<string[]> {
	const log = createLogger(environment.LOG_LEVEL, { service: 'PackIndex', repoId: packKey });
	const files = new Map<string, Uint8Array>();

	// If we have DO state, create a loader for existing loose objects (needed for thin packs)
	const looseLoader =
		doState && prefix ? createLooseLoader(asTypedStorage<RepoStateSchema>(doState.storage), environment, prefix) : undefined;

	const fs = createMemPackFs(files, { looseLoader });
	const gitdir = '/git';
	const dir = '/git';
	const packBase = `pack-input.pack`;
	const packPath = `${gitdir}/objects/pack/${packBase}`;

	await fs.promises.writeFile(packPath, packBytes);
	log.debug('index:start', { bytes: packBytes.byteLength });
	const { oids } = await git.indexPack({ fs, dir, filepath: `objects/pack/${packBase}` });

	// Store the index file to R2 for future range reads
	const indexBytes = files.get(`/git/objects/pack/pack-input.idx`);
	if (indexBytes) {
		const indexKey = packIndexKey(packKey);
		try {
			await environment.REPO_BUCKET.put(indexKey, indexBytes);
			log.info('index:stored-idx', { idxKey: indexKey, size: indexBytes.byteLength });
		} catch (error) {
			log.warn('index:store-idx-failed', { error: String(error) });
		}
	}

	log.info('index:ok', { count: oids.length });
	return oids;
}

/**
 * Unpacks a specific list of OIDs from a PACK file into DO storage.
 * Creates an in-memory fs, ensures `.idx` is present (from R2 or indexed locally),
 * then reads each object via isomorphic-git and stores the compressed object to DO + mirrors to R2.
 *
 * This function intentionally does not enforce a time budget; callers (e.g., the repo DO alarm)
 * should split work into chunks and schedule resumption according to configured budgets.
 *
 * @param packBytes Raw `.pack` bytes
 * @param state Durable Object state for the repository
 * @param env Worker environment (R2 and vars)
 * @param prefix DO prefix used to derive loose object R2 keys
 * @param packKey R2 `.pack` key for locating `.idx` (or indexing locally if missing)
 * @param oids Subset of object IDs to unpack this invocation
 * @returns Number of objects successfully processed
 */
export async function unpackOidsChunkFromPackBytes(
	packBytes: Uint8Array,
	state: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	packKey: string,
	oids: string[],
): Promise<number> {
	const log = createLogger(environment.LOG_LEVEL, { service: 'UnpackChunk', repoId: prefix });
	const store = asTypedStorage<RepoStateSchema>(state.storage);
	const files = new Map<string, Uint8Array>();

	// Create a loader for existing loose objects (needed for thin packs)
	const looseLoader = createLooseLoader(store, environment, prefix);

	const fs = createMemPackFs(files, { looseLoader });
	const gitdir = '/git';
	const dir = '/git';
	const packBase = `pack-input.pack`;
	const packPath = `${gitdir}/objects/pack/${packBase}`;
	await fs.promises.writeFile(packPath, packBytes);
	log.debug('chunk:start', { bytes: packBytes.byteLength });
	const indexPath = `${gitdir}/objects/pack/pack-input.idx`;
	const indexKey = packIndexKey(packKey);
	try {
		const indexObject = await environment.REPO_BUCKET.get(indexKey);
		if (indexObject) {
			const indexBytes = new Uint8Array(await indexObject.arrayBuffer());
			await fs.promises.writeFile(indexPath, indexBytes);
			log.debug('chunk:loaded-idx', { idxKey: indexKey, size: indexBytes.byteLength });
		} else {
			await git.indexPack({ fs, dir, filepath: `objects/pack/${packBase}` });
			log.debug('chunk:indexed-local', {});
		}
	} catch {
		// Fallback to local index if R2 read fails
		await git.indexPack({ fs, dir, filepath: `objects/pack/${packBase}` });
		log.warn('chunk:index-fallback', {});
	}
	let ok = 0;
	// Use a small, fixed concurrency for R2 mirrors to avoid excessive parallelism
	const r2Concurrency = 4;
	const pendingR2: Promise<void>[] = [];

	async function flushPending() {
		if (pendingR2.length === 0) return;
		try {
			await Promise.allSettled(pendingR2.splice(0));
		} catch {}
	}

	for (const oid of oids) {
		try {
			const { object, type } = (await git.readObject({
				fs,
				dir,
				gitdir,
				oid,
				format: 'content',
			})) as {
				object: Uint8Array;
				type: 'blob' | 'tree' | 'commit' | 'tag';
			};
			const { zdata } = await encodeGitObjectAndDeflate(type, object);
			await store.put(objKey(oid), zdata);
			// Mirror to R2 with limited concurrency
			pendingR2.push(
				(async () => {
					try {
						await environment.REPO_BUCKET.put(r2LooseKey(prefix, oid), zdata);
					} catch (error) {
						log.warn('chunk:mirror-r2-failed', { oid, error: String(error) });
					}
				})(),
			);
			if (pendingR2.length >= r2Concurrency) {
				await flushPending();
			}
			ok++;
		} catch (error) {
			log.debug('chunk:read-failed', { oid, error: String(error) });
		}
	}
	// Flush any remaining R2 mirrors
	await flushPending();
	log.debug('chunk:done', { processed: ok, requested: oids.length });
	return ok;
}

/**
 * Encode a git object with header and deflate (zlib) it.
 * Returns the computed SHA-1 OID and compressed bytes.
 *
 * @param type Git object type
 * @param payload Raw, uncompressed object payload bytes
 * @returns `{ oid, zdata }` where `zdata` is the zlib-compressed object including header
 */
export async function encodeGitObjectAndDeflate(type: 'blob' | 'tree' | 'commit' | 'tag', payload: Uint8Array) {
	const header = new TextEncoder().encode(`${type} ${payload.byteLength}\0`);
	const raw = new Uint8Array(header.byteLength + payload.byteLength);
	raw.set(header, 0);
	raw.set(payload, header.byteLength);
	const hash = await crypto.subtle.digest('SHA-1', raw);
	const oid = bytesToHex(new Uint8Array(hash));
	// Use deflate utility to compress
	const zdata = await deflate(raw);
	return { oid, zdata };
}

/**
 * Creates a minimal in-memory filesystem for isomorphic-git operations.
 *
 * Responsibilities
 * - Provide just enough of an FS for isomorphic-git to parse PACK/IDX files we load into memory.
 * - Optionally lazy-load loose objects via `opts.looseLoader(oid)` when isomorphic-git dereferences
 *   paths like `/git/objects/aa/bb...` that are not present in `files` (useful for thin deltas and
 *   connectivity checks that need bases not contained in the current pack).
 * - Normalize all paths so that any `.../objects/pack/*` or `.../objects/*` map under `/git/...`.
 * - Support both Promise-based and Node-style callback APIs via lightweight wrappers.
 *
 * Path conventions
 * - PACK/IDX bytes should be placed at `/git/objects/pack/<name>.pack|.idx`.
 * - Some isomorphic-git flows address temporary paths under `/work/` — we map those back to
 *   `/git/objects/pack/*` to keep a single source of truth in-memory.
 *
 * @param files Backing map for file contents keyed by normalized path (see above)
 * @param opts Optional behavior toggles; `looseLoader` returns zlib-compressed loose bytes for an OID
 * @returns A Node-like fs object with `promises` and callback-style methods sufficient for isomorphic-git
 */
export function createMemPackFs(
	files: Map<string, Uint8Array>,
	options?: { looseLoader?: (oid: string) => Promise<Uint8Array | undefined> },
) {
	// Internal helper to resolve a normalized path from the in-memory map or via the optional loose loader
	async function resolveFromMapOrLoose(p: string): Promise<Uint8Array | undefined> {
		let buf = files.get(p);
		if (!buf && p.startsWith('/work/')) {
			const base = p.slice('/work/'.length);
			buf = files.get(`/git/objects/pack/${base}`);
		}
		if (!buf && options?.looseLoader) {
			const m = p.match(/^\/git\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/i);
			if (m) {
				const oid = (m[1] + m[2]).toLowerCase();
				const z = await options.looseLoader(oid);
				if (z) {
					files.set(p, z);
					buf = z;
				}
			}
		}
		return buf;
	}
	const promises = {
		async readFile(path: string) {
			const p = normalize(path);
			const buf = await resolveFromMapOrLoose(p);
			if (!buf) throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
			return buf;
		},
		async writeFile(path: string, data: Uint8Array | string) {
			const p = normalize(path);
			const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
			files.set(p, bytes);
		},
		async stat(path: string) {
			const p = normalize(path);
			if (isDir(p)) return mkDirStat();
			const buf = await resolveFromMapOrLoose(p);
			if (!buf) {
				throw Object.assign(new Error(`ENOENT: no such file, stat '${p}'`), { code: 'ENOENT' });
			}
			return mkFileStat(buf.byteLength);
		},
		async lstat(path: string) {
			return promises.stat(path);
		},
		async readdir(path: string) {
			const p = normalize(path);
			// List pack files if asking for pack dir or work dir
			if (p === '/git/objects/pack' || p === '/git/objects/pack/') {
				return [...files.keys()].filter((k) => k.startsWith('/git/objects/pack/')).map((k) => k.slice('/git/objects/pack/'.length));
			}
			if (p === '/work' || p === '/work/') {
				return [...files.keys()].filter((k) => k.startsWith('/git/objects/pack/')).map((k) => k.slice('/git/objects/pack/'.length));
			}
			return [] as string[];
		},
		async mkdir(_path: string) {
			/* no-op */
		},
		async unlink(path: string) {
			files.delete(normalize(path));
		},
		// Stubs required by isomorphic-git bindFs
		async readlink(_path: string) {
			throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' });
		},
		async symlink(_target: string, _path: string) {
			throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' });
		},
		async rmdir(_path: string) {
			/* no-op */
		},
		async chmod(_path: string, _mode: number) {
			/* no-op */
		},
		async rename(_oldPath: string, _newPath: string) {
			/* no-op */
		},
		async rm(path: string) {
			return promises.unlink(path);
		},
		async open(_path: string, _flags?: any, _mode?: any) {
			throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' });
		},
		async close(_fd: any) {
			/* no-op */
		},
		// Additional Node-style APIs that bindFs expects
		async read(_fd: any, _buffer: Uint8Array, _offset: number, _length: number, _position: number) {
			throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' });
		},
		async write(_fd: any, _buffer: Uint8Array, _offset?: number, _length?: number, _position?: number) {
			throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' });
		},
		async truncate(path: string, length_?: number) {
			const p = normalize(path);
			const buf = files.get(p) || new Uint8Array();
			const n = length_ ?? 0;
			const out =
				buf.byteLength >= n
					? buf.subarray(0, n)
					: (() => {
							const o = new Uint8Array(n);
							o.set(buf);
							return o;
						})();
			files.set(p, out);
		},
		async chown(_path: string, _uid: number, _gid: number) {
			/* no-op */
		},
		async utimes(_path: string, _atime: number | Date, _mtime: number | Date) {
			/* no-op */
		},
	};

	// Callback wrappers (Node-style), used by isomorphic-git bindFs when fs.promises is not detected
	function cbify<T extends any[], R>(function_: (...arguments_: T) => Promise<R>) {
		return (...arguments_: any[]) => {
			const callback = arguments_.at(-1) as (error: any, res?: any) => void;
			const a = arguments_.slice(0, -1);
			(function_ as Function)
				.apply(null, a)
				.then((res: any) => callback(null, res))
				.catch((error: any) => callback(error));
		};
	}

	const fsObject: any = {
		promises,
		readFile: cbify(promises.readFile),
		writeFile: cbify(promises.writeFile),
		readdir: cbify(promises.readdir),
		stat: cbify(promises.stat),
		lstat: cbify(promises.lstat),
		mkdir: cbify(promises.mkdir),
		unlink: cbify(promises.unlink),
		rmdir: cbify(promises.rmdir || (async (_: string) => {})),
		chmod: cbify(promises.chmod || (async (_: string, __: number) => {})),
		rename: cbify(promises.rename || (async (_: string, __: string) => {})),
		rm: cbify(promises.rm),
		readlink: cbify(promises.readlink),
		symlink: cbify(promises.symlink),
		open: cbify(promises.open),
		close: cbify(promises.close),
		read: cbify(promises.read),
		write: cbify(promises.write),
		truncate: cbify(promises.truncate),
		chown: cbify(promises.chown),
		utimes: cbify(promises.utimes),
	};
	return fsObject as any;
}

/**
 * Normalizes various path shapes used by isomorphic-git to our in-memory layout.
 * Maps any `.../objects/pack/*` or `.../objects/*` into a `/git/...` rooted path.
 * Handles Windows paths and special work directory paths.
 * @param path Input path from isomorphic-git
 * @returns Normalized path for our in-memory filesystem
 */
function normalize(path: string) {
	let norm = path.replaceAll('\\', '/');
	// If the path points into objects/pack or objects, canonicalize to /git prefix
	const packMatch = norm.match(/(?:^|\/)objects\/pack\/(.+)$/);
	if (packMatch) return `/git/objects/pack/${packMatch[1]}`;
	const objectMatch = norm.match(/(?:^|\/)objects\/(.+)$/);
	if (objectMatch) return `/git/objects/${objectMatch[1]}`;
	// isomorphic-git sometimes resolves pack filepath as `${dir}/${basename}`
	if (norm.startsWith('/work/')) {
		// strip trailing NULs and spaces
		norm = norm.replace(/\0.*$/, '');
		if (norm === '/work/pack-input.pack') return '/git/objects/pack/pack-input.pack';
		if (norm === '/work/pack-input.idx') return '/git/objects/pack/pack-input.idx';
		const base = norm.slice('/work/'.length);
		if (base.endsWith('.pack') || base.endsWith('.idx')) {
			return `/git/objects/pack/${base}`;
		}
	}
	if (!norm.startsWith('/')) return '/git/' + norm;
	return norm;
}
/**
 * Determines whether the path should be treated as a directory.
 * @param path Input path to check
 * @returns true if the path represents a directory
 */
function isDir(path: string) {
	return /\/objects\/pack\/?$/.test(path) || /\/objects\/?$/.test(path) || /\/\.git\/objects\/?$/.test(path);
}
/**
 * Creates a directory-like stat object for the in-memory filesystem.
 * @returns Stat object with directory properties
 */
function mkDirStat() {
	return {
		isFile: () => false,
		isDirectory: () => true,
		size: 0,
		mode: 0o04_0755,
		mtimeMs: Date.now(),
	};
}
/**
 * Creates a file-like stat object for the in-memory filesystem.
 * @param size File size in bytes
 * @returns Stat object with file properties
 */
function mkFileStat(size: number) {
	return {
		isFile: () => true,
		isDirectory: () => false,
		size,
		mode: 0o10_0644,
		mtimeMs: Date.now(),
	};
}
