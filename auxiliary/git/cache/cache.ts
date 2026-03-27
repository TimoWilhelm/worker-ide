/**
 * Small helpers around the Cloudflare Workers Cache API for JSON payloads.
 *
 * Notes
 * - Cache lives per colo; keys should be stable and include all inputs.
 * - Always use the same origin as the incoming request when constructing keys.
 * - Only cache GET responses.
 */

import { asBodyInit } from '@git/common/web-types';

const CACHE_NAME_OBJECTS = 'git-on-cf:objects';

/**
 * Optional per-request memoization store to avoid repeated upstream calls
 * (DO RPCs, R2) within a single Worker request.
 */
export interface RequestMemo {
	/** Pin the repository for this request memo to prevent cross-repo contamination */
	repoId?: string;
	/** Object results by OID (git header removed) */
	objects?: Map<string, { type: string; payload: Uint8Array } | undefined>;
	/** Parsed references for objects: commit -> [tree, parents], tree -> [entries] */
	refs?: Map<string, string[]>;
	/** Candidate pack list for the current repo (once per request) */
	packList?: string[];
	/** In-flight promise for candidate pack list to coalesce concurrent discovery */
	packListPromise?: Promise<string[]>;
	/** Pack OIDs by pack key */
	packOids?: Map<string, Set<string>>;
	/** In-memory virtual FS for pack files to reuse across OIDs (current repo only) */
	packFiles?: Map<string, Uint8Array>;
	/** Small flags set for once-per-request log throttling and guards */
	flags?: Set<string>;
	/** Remaining DO batch budget for getObjectRefsBatch (shared across both closures) */
	doBatchBudget?: number;
	/** If true, disable further DO refs batches due to errors or budgets */
	doBatchDisabled?: boolean;
	/** Count of DO-backed loose loader calls (stub.getObject) within this request */
	loaderCalls?: number;
	/** Soft cap for DO-backed loose loader calls; can be adjusted between phases (closure vs fallback) */
	loaderCap?: number;
	/** Optional per-request soft subrequest budget to degrade before hitting platform hard limits */
	subreqBudget?: number;
	/** Optional concurrency limiter for upstream calls; must provide a run(label, fn) API */
	limiter?: { run<T>(label: string, function_: () => Promise<T>): Promise<T> };
}

/**
 * Context for cacheable operations.
 * Combines request and execution context for caching and background tasks.
 * When provided, both fields are required since they typically come together.
 */
export interface CacheContext {
	req: Request;
	ctx: ExecutionContext;
	/** Optional per-request memoization */
	memo?: RequestMemo;
}

/**
 * Resolve the zone cache instance used for git objects.
 * Git objects are immutable, so we use a separate cache with longer TTLs.
 */
async function getObjectCache(): Promise<Cache> {
	return await caches.open(CACHE_NAME_OBJECTS);
}

/**
 * Build a cache key for a git object.
 * Git objects are content-addressable and immutable, so we can use long TTLs.
 *
 * @param req - The incoming request (for origin)
 * @param repoId - Repository identifier (owner/repo)
 * @param oid - Object ID (SHA-1 hash)
 * @returns Cache key request
 */
export function buildObjectCacheKey(request: Request, repoId: string, oid: string): Request {
	const u = new URL(request.url);
	u.pathname = `/_cache/obj/${repoId}/${oid.toLowerCase()}`;
	u.search = '';
	return new Request(u.toString(), { method: 'GET' });
}

/**
 * Retrieve a git object from cache.
 *
 * @param keyReq - The cache key request
 * @returns Object data with type and payload, or null on miss
 */
async function cacheGetObject(keyRequest: Request): Promise<{ type: string; payload: Uint8Array } | null> {
	try {
		const cache = await getObjectCache();
		const res = await cache.match(keyRequest);
		if (!res || !res.ok) return null;

		// Objects are stored as binary with type in header
		const type = res.headers.get('X-Git-Type') || 'blob';
		const payload = new Uint8Array(await res.arrayBuffer());
		return { type, payload };
	} catch {
		return null;
	}
}

/**
 * Store a git object in cache with immutable headers.
 * Since git objects are content-addressed, they never change.
 *
 * @param keyReq - Cache key request
 * @param type - Git object type (blob, tree, commit, tag)
 * @param payload - Raw object payload (without git header)
 */
export async function cachePutObject(keyRequest: Request, type: string, payload: Uint8Array): Promise<void> {
	try {
		const headers = new Headers();
		headers.set('Content-Type', 'application/octet-stream');
		headers.set('X-Git-Type', type);
		// Git objects are immutable - cache for 1 year
		headers.set('Cache-Control', 'public, max-age=31536000, immutable');

		const res = new Response(asBodyInit(payload), { status: 200, headers });
		const cache = await getObjectCache();
		await cache.put(keyRequest, res);
	} catch {
		// best-effort only
	}
}

/**
 * Helper to handle the check-load-save cache pattern with ctx.waitUntil.
 * Checks cache first, loads from source if needed, and saves to cache in background.
 *
 * @param cacheKey - The cache key request
 * @param loader - Function to load the data if not cached
 * @param ctx - ExecutionContext for waitUntil (optional)
 * @returns The cached or loaded git object
 */
export async function cacheOrLoadObject(
	cacheKey: Request,
	loader: () => Promise<{ type: string; payload: Uint8Array } | undefined>,
	context?: ExecutionContext,
): Promise<{ type: string; payload: Uint8Array } | undefined> {
	// Try cache first
	const cached = await cacheGetObject(cacheKey);
	if (cached) {
		return cached;
	}

	// Load from source
	const result = await loader();
	if (!result) return undefined;

	// Save to cache in background if ctx is provided
	const savePromise = cachePutObject(cacheKey, result.type, result.payload);
	if (context) {
		context.waitUntil(savePromise);
	} else {
		// If no ctx, we still save but don't wait
		savePromise.catch(() => {}); // Ignore errors
	}

	return result;
}
