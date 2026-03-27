import { packIndexKey } from '@git/keys';

import { type IdxParsed as IndexParsed, parseIdxV2 as parseIndexV2 } from './pack-meta';

// --- In-process LRU cache for parsed .idx files (ephemeral per isolate) ---
const IDX_CACHE_MAX = 64;
const indexCache = new Map<string, IndexParsed>(); // key: packKey

function touchIndexCache(key: string, value: IndexParsed) {
	if (indexCache.has(key)) indexCache.delete(key);
	indexCache.set(key, value);
	if (indexCache.size > IDX_CACHE_MAX) {
		const first = indexCache.keys().next().value;
		if (first) indexCache.delete(first);
	}
}

export async function loadIdxParsed(
	environment: GitWorkerEnvironment,
	packKey: string,
	options?: {
		limiter?: { run<T>(label: string, function_: () => Promise<T>): Promise<T> };
		countSubrequest?: (n?: number) => void;
		signal?: AbortSignal;
	},
): Promise<IndexParsed | undefined> {
	const cached = indexCache.get(packKey);
	if (cached) {
		// Touch for LRU
		touchIndexCache(packKey, cached);
		return cached;
	}
	const indexKey = packIndexKey(packKey);
	if (options?.signal?.aborted) return undefined;
	const run = async () => await environment.REPO_BUCKET.get(indexKey);
	const indexObject = options?.limiter
		? await options.limiter.run('r2:get-idx', async () => {
				options.countSubrequest?.();
				return await run();
			})
		: await run();
	if (!indexObject) return undefined;
	const indexBuf = new Uint8Array(await indexObject.arrayBuffer());
	const parsed = parseIndexV2(indexBuf);
	if (!parsed) return undefined;
	touchIndexCache(packKey, parsed);
	return parsed;
}
