/**
 * Bundle Cache Service.
 *
 * Caches transformed frontend bundles using the Workers Cache API.
 * The cache key is a SHA-256 hash of all source files, their contents,
 * the dependency map, and the tsconfig — so any change to inputs
 * naturally produces a different key (content-addressable caching).
 *
 * This avoids re-running esbuild on every preview request when the
 * source files haven't changed, which is the common case during
 * navigation, page reloads, and HMR reconnects.
 */

import { waitUntil } from 'cloudflare:workers';

const CACHE_NAME = 'bundle-cache-v1';

/**
 * Synthetic origin used to construct Cache API request keys.
 * The Workers Cache API requires valid URLs, but these never leave the worker.
 */
const CACHE_ORIGIN = 'https://bundle-cache.internal';

/**
 * Compute a SHA-256 content hash from all bundle inputs.
 *
 * The hash covers:
 * - All source file paths and their contents (sorted for determinism)
 * - The entry point path
 * - The dependency map (package names and versions, sorted)
 * - The tsconfig raw string (if present)
 *
 * This means any file edit, dependency version bump, or tsconfig change
 * produces a different hash and therefore a cache miss.
 */
async function computeBundleHash(
	files: Record<string, string>,
	entryPoint: string,
	dependencies: Map<string, string>,
	tsconfigRaw?: string,
): Promise<string> {
	// Sort file entries for deterministic hashing
	const sortedFiles = Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b));

	// Sort dependencies for deterministic hashing
	const sortedDependencies = [...dependencies.entries()].toSorted(([a], [b]) => a.localeCompare(b));

	// Build a single string that uniquely represents all inputs.
	// Using null bytes as separators to avoid collisions between
	// file paths/contents that could otherwise be ambiguous.
	const parts: string[] = [`entry:${entryPoint}`, `tsconfig:${tsconfigRaw ?? ''}`, `deps:${JSON.stringify(sortedDependencies)}`];

	for (const [path, content] of sortedFiles) {
		parts.push(`file:${path}\0${content}`);
	}

	const encoder = new TextEncoder();
	const data = encoder.encode(parts.join('\0'));
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = [...new Uint8Array(hashBuffer)];
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Look up a cached bundle by its content hash.
 * Returns the cached JavaScript source or undefined on miss.
 */
export async function getCachedBundle(
	files: Record<string, string>,
	entryPoint: string,
	dependencies: Map<string, string>,
	tsconfigRaw?: string,
): Promise<string | undefined> {
	const hash = await computeBundleHash(files, entryPoint, dependencies, tsconfigRaw);
	const cacheKey = `${CACHE_ORIGIN}/bundle/${hash}`;

	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(cacheKey);
	if (!cached) {
		return undefined;
	}

	return cached.text();
}

/**
 * Store a bundle result in the cache, keyed by content hash.
 *
 * Uses `waitUntil` from `cloudflare:workers` to ensure the cache write
 * completes even after the response has been sent to the client.
 * This avoids blocking the response on the cache write while still
 * guaranteeing the write isn't silently dropped.
 */
export function putCachedBundle(
	files: Record<string, string>,
	entryPoint: string,
	dependencies: Map<string, string>,
	tsconfigRaw: string | undefined,
	code: string,
): void {
	const writePromise = (async () => {
		const hash = await computeBundleHash(files, entryPoint, dependencies, tsconfigRaw);
		const cacheKey = `${CACHE_ORIGIN}/bundle/${hash}`;

		const cache = await caches.open(CACHE_NAME);
		const response = new Response(code, {
			headers: {
				'Content-Type': 'application/javascript',
				// Content-addressable: the hash changes when inputs change,
				// so a long TTL is safe. 7 days is a reasonable upper bound
				// before Cloudflare evicts it anyway.
				'Cache-Control': 'public, max-age=604800',
			},
		});

		await cache.put(cacheKey, response);
	})();

	waitUntil(writePromise);
}
