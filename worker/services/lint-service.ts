import { waitUntil } from 'cloudflare:workers';

import { lintFileForAgent } from './agent/lib/biome-linter';

import type { ServerLintDiagnostic } from '@shared/biome-types';

// Re-export types and helpers so callers only need to import from this module
export type { FixFileFailure, ServerLintDiagnostic, ServerFixResult } from '@shared/biome-types';
export { formatLintDiagnostics } from './agent/lib/biome-linter';

const CACHE_NAME = 'lint-cache-v1';
const CACHE_ORIGIN = 'https://lint-cache.internal';

/**
 * Compute a SHA-256 hash of the lint inputs (file path + content).
 * The file path determines which language the linter uses, so it must
 * be part of the key even though it doesn't appear in the file content.
 */
async function computeLintHash(filePath: string, content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(`${filePath}\0${content}`);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = [...new Uint8Array(hashBuffer)];
	return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Look up cached lint diagnostics by content hash.
 * Returns the cached diagnostics array or undefined on miss.
 */
async function getCachedLint(filePath: string, content: string): Promise<ServerLintDiagnostic[] | undefined> {
	try {
		const hash = await computeLintHash(filePath, content);
		const cacheKey = `${CACHE_ORIGIN}/lint/${hash}`;

		const cache = await caches.open(CACHE_NAME);
		const cached = await cache.match(cacheKey);
		if (!cached) return undefined;

		return cached.json();
	} catch {
		return undefined;
	}
}

/**
 * Store lint diagnostics in the cache, keyed by content hash.
 * Runs in the background via `waitUntil` so it doesn't block the caller.
 */
function putCachedLint(filePath: string, content: string, diagnostics: ServerLintDiagnostic[]): void {
	const writePromise = (async () => {
		const hash = await computeLintHash(filePath, content);
		const cacheKey = `${CACHE_ORIGIN}/lint/${hash}`;

		const cache = await caches.open(CACHE_NAME);
		const response = Response.json(diagnostics, {
			headers: {
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

/**
 * Lint a file and return diagnostics with transparent caching.
 *
 * On cache hit, returns immediately from the Workers Cache API.
 * On miss, delegates to the underlying linter, stores the result
 * in the background, and returns the diagnostics.
 *
 * Returns an empty array if the file type is unsupported or the
 * linter is unavailable.
 */
export async function lintFile(filePath: string, content: string): Promise<ServerLintDiagnostic[]> {
	const cached = await getCachedLint(filePath, content);
	if (cached) return cached;

	const diagnostics = await lintFileForAgent(filePath, content);
	if (diagnostics.length > 0) {
		putCachedLint(filePath, content, diagnostics);
	}
	return diagnostics;
}

/**
 * Format a file and apply safe lint fixes.
 *
 * Results are not cached because the operation is infrequent and
 * the caller typically writes the fixed content back to disk immediately.
 */
export { fixFileForAgent as fixFile, applySingleFixForAgent as applySingleFix } from './agent/lib/biome-linter';
