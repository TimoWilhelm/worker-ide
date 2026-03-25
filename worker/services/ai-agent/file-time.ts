/**
 * FileTime Service - Tracks when files are read for session-isolated validation.
 *
 * This service ensures that files are read before being written, preventing
 * accidental overwrites. Uses filesystem persistence so state survives
 * Durable Object evictions, with an in-memory promise cache for fast,
 * race-free access within the same isolate.
 *
 * Storage location: {projectRoot}/.agent/sessions/{sessionId}/filetime.json
 *
 * Also provides per-file write locks so concurrent writes to the same file
 * are serialized, and mtime checking to detect external modifications.
 */

import fs from 'node:fs/promises';

// =============================================================================
// Constants & State
// =============================================================================

const SESSIONS_DIR = '.agent/sessions';

// In-memory cache: key -> Promise<Map of filepath -> timestamp (ms)>.
//
// Storing promises (rather than resolved Maps) is the key design choice here.
// It means that if two callers race to load the same session before the first
// load finishes, they both await the *same* Promise and therefore both receive
// the *same* Map instance.  Were we to store the resolved Map directly there
// would be a window between "cache miss detected" and "cache entry written"
// during which a second concurrent caller also sees a cache miss, kicks off its
// own fs.readFile, and builds an independent Map — causing the two callers to
// operate on different objects.  That classic cache-stampede / lost-update race
// is what this design prevents.
//
// On Durable Object eviction the module-level state is reset, so the promise
// cache starts empty and the next access re-reads from disk, which is correct.
const sessionCache = new Map<string, Promise<Map<string, number>>>();

// Per-file write locks for serializing concurrent writes
const locks = new Map<string, Promise<void>>();

// =============================================================================
// Helpers
// =============================================================================

function cacheKey(projectRoot: string, sessionId: string): string {
	return `${projectRoot}\0${sessionId}`;
}

function getFiletimePath(projectRoot: string, sessionId: string): string {
	return `${projectRoot}/${SESSIONS_DIR}/${sessionId}/filetime.json`;
}

function getSessionDirectory(projectRoot: string, sessionId: string): string {
	return `${projectRoot}/${SESSIONS_DIR}/${sessionId}`;
}

function normalizePath(filepath: string): string {
	return filepath.startsWith('/') ? filepath : `/${filepath}`;
}

async function readFileTimesFromDisk(projectRoot: string, sessionId: string): Promise<Map<string, number>> {
	try {
		const content = await fs.readFile(getFiletimePath(projectRoot, sessionId), 'utf8');
		const data: Record<string, number> = JSON.parse(content);
		return new Map(Object.entries(data));
	} catch {
		return new Map<string, number>();
	}
}

/**
 * Returns the shared, mutable Map for the given session.
 *
 * The cache stores Promises rather than resolved Maps.  This eliminates the
 * cache-stampede race: if two callers see an empty cache entry at the same
 * moment, they both await the *same* Promise and therefore receive the *same*
 * Map instance.  Any mutation one caller makes (e.g. recording a file read) is
 * immediately visible to the other, because they share the same object.
 */
async function loadFileTimes(projectRoot: string, sessionId: string): Promise<Map<string, number>> {
	const key = cacheKey(projectRoot, sessionId);

	const cached = sessionCache.get(key);
	if (cached) return cached;

	const loading = readFileTimesFromDisk(projectRoot, sessionId);
	sessionCache.set(key, loading);
	return loading;
}

async function flushFileTimes(projectRoot: string, sessionId: string, times: Map<string, number>): Promise<void> {
	const directory = getSessionDirectory(projectRoot, sessionId);
	await fs.mkdir(directory, { recursive: true });

	const filePath = getFiletimePath(projectRoot, sessionId);
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	const data = Object.fromEntries(times);

	// Atomic write: write to temp file then rename
	await fs.writeFile(temporaryPath, JSON.stringify(data));
	await fs.rename(temporaryPath, filePath);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Record that a file was read. Call this after successfully reading a file.
 * This also serves to mark newly created/written files as "read" so subsequent edits work.
 *
 * Uses the file's actual mtime from the filesystem rather than Date.now() to
 * avoid clock skew between the Worker isolate and the Durable Object that
 * backs the virtual filesystem — both produce independent Date.now() values
 * which can drift by a few milliseconds, causing false "file changed externally"
 * errors on the very next edit.
 */
export async function recordFileRead(projectRoot: string, sessionId: string, filepath: string): Promise<void> {
	const normalized = normalizePath(filepath);
	const times = await loadFileTimes(projectRoot, sessionId);

	// Stat the file to get its actual mtime so the recorded timestamp and
	// the value returned by future stat() calls come from the same clock.
	let timestamp: number;
	try {
		const stats = await fs.stat(`${projectRoot}${normalized}`);
		timestamp = stats.mtime.getTime();
	} catch {
		// File may not exist yet (e.g., about to be created), fall back
		timestamp = Date.now();
	}

	times.set(normalized, timestamp);
	await flushFileTimes(projectRoot, sessionId, times);
}

/**
 * Assert that a file was read before attempting to write/edit it.
 * Throws if the file wasn't read, or if the file has been modified on disk
 * since it was last read (detects external changes).
 */
export async function assertFileWasRead(projectRoot: string, sessionId: string, filepath: string): Promise<void> {
	const times = await loadFileTimes(projectRoot, sessionId);
	const readTime = times.get(normalizePath(filepath));

	if (readTime === undefined) {
		throw new Error(`You must read file ${filepath} before overwriting it. Use the file_read tool first.`);
	}

	// Check if the file was modified on disk since last read
	try {
		const stats = await fs.stat(`${projectRoot}${normalizePath(filepath)}`);
		if (stats.mtime.getTime() > readTime) {
			const readDate = new Date(readTime);
			throw new Error(
				`File ${filepath} has been modified since it was last read.\n` +
					`Last modification: ${stats.mtime.toISOString()}\n` +
					`Last read: ${readDate.toISOString()}\n\n` +
					`Please read the file again before modifying it.`,
			);
		}
	} catch (error) {
		// Re-throw our own errors, ignore stat failures (file may not exist yet)
		if (error instanceof Error && error.message.includes('has been modified since')) {
			throw error;
		}
	}
}

/**
 * Serialize concurrent writes to the same file. All tools that overwrite
 * existing files should run their assert/read/write/update sequence inside
 * withLock so concurrent writes are serialized.
 */
export async function withLock<T>(filepath: string, function_: () => Promise<T>): Promise<T> {
	const normalized = normalizePath(filepath);
	const currentLock = locks.get(normalized) ?? Promise.resolve();

	// Create a deferred promise whose resolve function acts as the lock release.
	let resolve!: () => void;
	const nextLock = new Promise<void>((r) => {
		resolve = r;
	});
	const chained = currentLock.then(() => nextLock);
	locks.set(normalized, chained);

	await currentLock;
	try {
		return await function_();
	} finally {
		resolve();
		if (locks.get(normalized) === chained) {
			locks.delete(normalized);
		}
	}
}

/**
 * Evict the in-memory cache entry for a session.
 *
 * Call this when a session ends so that the promise cache does not grow
 * indefinitely over the lifetime of a long-lived Durable Object instance.
 * Disk cleanup (the `.agent/sessions/{id}/` directory) is handled separately
 * by `cleanupSessionArtifacts` in `session-cleanup.ts`.
 */
export function clearSession(projectRoot: string, sessionId: string): void {
	sessionCache.delete(cacheKey(projectRoot, sessionId));
}
