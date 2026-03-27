import { createLogger } from '@git/common/index';
import { doPrefix, r2PackDirPrefix, isPackKey } from '@git/keys';

import { getLimiter, countSubrequest, DEFAULT_SUBREQUEST_BUDGET } from './limits';

import type { CacheContext } from '@git/cache/index';
import type { RepoDurableObject } from '@git/do/index';

// ---- local helpers (module-scoped) ----
function orderPacksByPriority(list: string[]): string[] {
	const hydra: string[] = [];
	const normal: string[] = [];
	for (const k of list) {
		const base = k.split('/').pop() || '';
		if (base.startsWith('pack-hydr-')) hydra.push(k);
		else normal.push(k);
	}
	// Return hydration packs first, then normal packs
	// Hydration packs now contain full delta chains and are optimized for initial clones
	return [...hydra, ...normal];
}

function mergeUnique(dst: string[], extra: string[]) {
	const seen = new Set(dst);
	for (const k of extra)
		if (!seen.has(k)) {
			seen.add(k);
			dst.push(k);
		}
}

/**
 * Shared helper to discover candidate pack keys for a repository.
 * Order semantics: newest-first when seeded from DO; R2 scan is best-effort.
 * Results are memoized per request in `cacheCtx.memo.packList` when provided.
 */
export async function getPackCandidates(
	environment: GitWorkerEnvironment,
	stub: DurableObjectStub<RepoDurableObject>,
	doId: string,
	heavy: boolean,
	cacheContext?: CacheContext,
	options?: { expandR2?: boolean },
): Promise<string[]> {
	// Reuse per-request memo when not expanding; when expanding, seed from memo but continue
	if (!options?.expandR2) {
		if (cacheContext?.memo?.packList && Array.isArray(cacheContext.memo.packList)) {
			return cacheContext.memo.packList;
		}
		// Coalesce concurrent discovery calls within the same request
		if (cacheContext?.memo?.packListPromise) {
			try {
				const existing = await cacheContext.memo.packListPromise;
				return existing;
			} catch {
				// fall-through to attempt discovery again; promise creators log errors below
			}
		}
	}

	const limiter = getLimiter(cacheContext);
	// Ensure soft budget is initialized for the request
	if (cacheContext) cacheContext.memo = cacheContext.memo || { subreqBudget: DEFAULT_SUBREQUEST_BUDGET };
	const log = createLogger(environment.LOG_LEVEL, { service: 'PackDiscovery', doId });

	let packList: string[] = Array.isArray(cacheContext?.memo?.packList) ? [...cacheContext!.memo!.packList!] : [];
	const dedupe = (array: string[]) => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const k of array) {
			if (!seen.has(k)) {
				seen.add(k);
				out.push(k);
			}
		}
		return out;
	};

	const inflight = (async () => {
		// Seed with latest pack if available
		try {
			const meta = await limiter.run('do:getPackLatest', async () => {
				countSubrequest(cacheContext);
				return await stub.getPackLatest();
			});
			const latest = meta?.key;
			if (latest && !packList.includes(latest)) packList.push(latest);
		} catch (error) {
			log.debug('packDiscovery:getPackLatest:error', { error: String(error) });
		}

		// Always include DO /packs (deduped) to broaden candidates for multi-pack assembly
		try {
			const list = await limiter.run('do:getPacks', async () => {
				countSubrequest(cacheContext);
				return await stub.getPacks();
			});
			if (Array.isArray(list) && list.length > 0) {
				// Ensure latest is first
				if (packList.length > 0) {
					const latest = packList[0];
					const index = list.indexOf(latest);
					if (index !== -1) list.splice(index, 1);
					packList = dedupe([latest, ...orderPacksByPriority(list)]);
				} else {
					// No latest: order by priority (hydration packs first)
					packList = orderPacksByPriority(list);
				}
			}
		} catch {}

		// R2 scan: use as last resort when we have no candidates,
		// or as an expansion when explicitly requested via options.expandR2
		if (packList.length === 0 || options?.expandR2) {
			try {
				const prefix = r2PackDirPrefix(doPrefix(doId));
				const MAX = heavy ? 10 : 50;
				let cursor: string | undefined;
				const found: string[] = [];
				do {
					const res: any = await limiter.run('r2:list:packs', async () => {
						countSubrequest(cacheContext);
						return await environment.REPO_BUCKET.list({ prefix, cursor });
					});
					const objs: any[] = (res && res.objects) || [];
					for (const o of objs) {
						const key = String(o.key);
						if (isPackKey(key)) found.push(key);
						if (found.length >= MAX) break;
					}
					cursor = res && res.truncated ? res.cursor : undefined;
				} while (cursor && found.length < MAX);
				if (found.length > 0) {
					// Order by priority for R2 path as well (hydration packs first)
					const expanded = orderPacksByPriority(found);
					// If this was an expansion, merge while preserving order and deduping
					if (options?.expandR2 && packList.length > 0) {
						mergeUnique(packList, expanded);
					} else {
						packList = expanded;
					}
				}
			} catch (error) {
				log.debug('packDiscovery:r2:list:error', { error: String(error) });
			}
		}

		// Throttle noisy logging to once per request
		if (cacheContext?.memo) {
			cacheContext.memo.flags = cacheContext.memo.flags || new Set<string>();
			if (!cacheContext.memo.flags.has('pack-discovery-logged')) {
				log.debug('packDiscovery:candidates', { count: packList.length });
				cacheContext.memo.flags.add('pack-discovery-logged');
			}
		} else {
			log.debug('packDiscovery:candidates', { count: packList.length });
		}
		return packList;
	})();

	if (cacheContext?.memo && !options?.expandR2) cacheContext.memo.packListPromise = inflight;
	try {
		const list = await inflight;
		if (cacheContext?.memo) cacheContext.memo.packList = list;
		return list;
	} finally {
		if (cacheContext?.memo && !options?.expandR2) cacheContext.memo.packListPromise = undefined;
	}
}
