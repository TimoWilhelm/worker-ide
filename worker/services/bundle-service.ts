/**
 * Bundle Service.
 *
 * Public API for bundling project files. Provides transparent content-
 * addressable caching on top of the underlying bundler (currently esbuild
 * via the auxiliary worker). Callers get a single function that handles
 * cache lookup, bundling on miss, and background cache storage.
 *
 * The cache key is a SHA-256 hash of all bundle inputs (source files,
 * entry point, dependencies, tsconfig, platform, flags) — any change
 * to inputs naturally produces a different key.
 *
 * Usage:
 * ```ts
 * const result = await bundleFiles(options);
 * ```
 */

import { waitUntil } from 'cloudflare:workers';

import { bundleWithCdn } from './bundler-client';

import type { BundleResult, BundleWithCdnOptions } from '@shared/bundler-types';

// Re-export types so callers only need to import from this module
export type { BundleResult, BundleWithCdnOptions } from '@shared/bundler-types';

const CACHE_NAME = 'bundle-cache-v1';

/**
 * Synthetic origin used to construct Cache API request keys.
 * The Workers Cache API requires valid URLs, but these never leave the worker.
 */
const CACHE_ORIGIN = 'https://bundle-cache.internal';

// =============================================================================
// Content-Addressable Cache
// =============================================================================

/**
 * Compute a SHA-256 content hash from all bundle inputs.
 *
 * The hash covers:
 * - All source file paths and their contents (sorted for determinism)
 * - The entry point path
 * - The dependency map (package names and versions, sorted)
 * - The tsconfig raw string (if present)
 * - Platform, minify, sourcemap, and reactRefresh flags
 *
 * Any file edit, dependency version bump, tsconfig change, or flag toggle
 * produces a different hash and therefore a cache miss.
 */
async function computeBundleHash(options: BundleWithCdnOptions): Promise<string> {
	const { files, entryPoint, knownDependencies, tsconfigRaw, platform, minify, sourcemap, reactRefresh, externals } = options;

	// Sort file entries for deterministic hashing
	const sortedFiles = Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b));

	// Sort dependencies for deterministic hashing
	const sortedDependencies = knownDependencies ? [...knownDependencies.entries()].toSorted(([a], [b]) => a.localeCompare(b)) : [];

	// Build a single string that uniquely represents all inputs.
	// Using null bytes as separators to avoid collisions between
	// file paths/contents that could otherwise be ambiguous.
	const parts: string[] = [
		`entry:${entryPoint}`,
		`tsconfig:${tsconfigRaw ?? ''}`,
		`deps:${JSON.stringify(sortedDependencies)}`,
		`platform:${platform ?? 'browser'}`,
		`minify:${minify ?? false}`,
		`sourcemap:${sourcemap ?? false}`,
		`reactRefresh:${reactRefresh ?? false}`,
		`externals:${JSON.stringify(externals?.toSorted() ?? [])}`,
	];

	for (const [path, content] of sortedFiles) {
		parts.push(`file:${path}\0${content}`);
	}

	const encoder = new TextEncoder();
	const data = encoder.encode(parts.join('\0'));
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = [...new Uint8Array(hashBuffer)];
	return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Look up a cached bundle by its content hash.
 * Returns the cached JavaScript source or undefined on miss.
 */
async function getCachedBundle(options: BundleWithCdnOptions): Promise<string | undefined> {
	try {
		const hash = await computeBundleHash(options);
		const cacheKey = `${CACHE_ORIGIN}/bundle/${hash}`;

		const cache = await caches.open(CACHE_NAME);
		const cached = await cache.match(cacheKey);
		if (!cached) return undefined;

		return cached.text();
	} catch {
		return undefined;
	}
}

/**
 * Store a bundle result in the cache, keyed by content hash.
 * Runs in the background via `waitUntil` so it doesn't block the caller.
 */
function putCachedBundle(options: BundleWithCdnOptions, code: string): void {
	const writePromise = (async () => {
		const hash = await computeBundleHash(options);
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

// =============================================================================
// Public API
// =============================================================================

/**
 * Bundle files into a single JavaScript module with transparent caching.
 *
 * On cache hit, returns immediately with the cached code (no esbuild run).
 * On miss, delegates to the esbuild auxiliary worker, stores the result
 * in the Workers Cache API in the background, and returns the full result.
 */
export async function bundleFiles(options: BundleWithCdnOptions): Promise<BundleResult> {
	const cached = await getCachedBundle(options);
	if (cached !== undefined) {
		return { code: cached };
	}

	const result = await bundleWithCdn(options);
	putCachedBundle(options, result.code);
	return result;
}
