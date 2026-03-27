import { buildObjectCacheKey, cacheOrLoadObject, cachePutObject } from '@git/cache/index';
import { createLogger, getRepoStub } from '@git/common/index';
import { inflateAndParseHeader } from '@git/git/core/index';
import { createMemPackFs, createStubLooseLoader } from '@git/git/pack/index';
import { packIndexKey } from '@git/keys';
import * as git from 'isomorphic-git';

import { getLimiter, countSubrequest } from '../limits';
import { getPackCandidates } from '../pack-discovery';

import type { CacheContext } from '@git/cache/index';

const LOADER_CAP = 400; // cap DO loose-loader calls per request in heavy mode

export async function readLooseObjectRaw(
	environment: GitWorkerEnvironment,
	repoId: string,
	oid: string,
	cacheContext?: CacheContext,
): Promise<{ type: string; payload: Uint8Array } | undefined> {
	const oidLc = oid.toLowerCase();
	const stub = getRepoStub(environment, repoId);
	const doId = stub.id.toString();
	const logger = createLogger(environment.LOG_LEVEL, {
		service: 'readLooseObjectRaw',
		repoId,
		doId,
	});

	if (cacheContext) {
		if (!cacheContext.memo || (cacheContext.memo.repoId && cacheContext.memo.repoId !== repoId)) {
			cacheContext.memo = { repoId };
		} else if (!cacheContext.memo.repoId) {
			cacheContext.memo.repoId = repoId;
		}
	}

	if (cacheContext?.memo?.objects?.has(oidLc)) {
		return cacheContext.memo.objects.get(oidLc);
	}

	const heavyNoCache = cacheContext?.memo?.flags?.has('no-cache-read') === true;
	const limiter = getLimiter(cacheContext);

	async function addPackToFiles(environment_: GitWorkerEnvironment, packKey: string, files: Map<string, Uint8Array>): Promise<boolean> {
		const [p, index] = await Promise.all([
			limiter.run('r2:get-pack', async () => {
				if (!countSubrequest(cacheContext)) {
					logger.warn('soft-budget-exhausted', { op: 'r2:get-pack', key: packKey });
					return null;
				}
				return await environment_.REPO_BUCKET.get(packKey);
			}),
			limiter.run('r2:get-idx', async () => {
				if (!countSubrequest(cacheContext)) {
					logger.warn('soft-budget-exhausted', { op: 'r2:get-idx', key: packKey });
					return null;
				}
				return await environment_.REPO_BUCKET.get(packIndexKey(packKey));
			}),
		]);
		if (!p || !index) return false;

		const [packArrayBuf, indexArrayBuf] = await Promise.all([p.arrayBuffer(), index.arrayBuffer()]);
		const packBuf = new Uint8Array(packArrayBuf);
		const indexBuf = new Uint8Array(indexArrayBuf);
		const base = packKey.split('/').pop()!;
		const indexBase = base.replace(/\.pack$/i, '.idx');
		files.set(`/git/objects/pack/${base}`, packBuf);
		files.set(`/git/objects/pack/${indexBase}`, indexBuf);
		return true;
	}

	const loadFromPacks = async () => {
		try {
			const packListRaw = await getPackCandidates(environment, stub, doId, heavyNoCache, cacheContext);
			let packList: string[] = packListRaw;
			const PROBE_MAX = heavyNoCache ? 10 : packList.length;
			if (packList.length > PROBE_MAX) packList = packList.slice(0, PROBE_MAX);
			if (cacheContext?.memo) {
				cacheContext.memo.flags = cacheContext.memo.flags || new Set();
				if (!cacheContext.memo.flags.has('pack-list-candidates-logged')) {
					logger.debug('pack-list-candidates', { count: packList.length });
					cacheContext.memo.flags.add('pack-list-candidates-logged');
				}
			} else {
				logger.debug('pack-list-candidates', { count: packList.length });
			}
			if (packList.length === 0) {
				const alreadyWarned = cacheContext?.memo?.flags?.has('pack-list-empty');
				if (!alreadyWarned) {
					logger.warn('pack-list-empty', { oid: oidLc, afterFallbacks: true });
					if (cacheContext?.memo) {
						cacheContext.memo.flags = cacheContext.memo.flags || new Set();
						cacheContext.memo.flags.add('pack-list-empty');
					}
				}
				return;
			}

			let chosenPackKey: string | undefined;
			const contains: Record<string, boolean> = {};
			for (const key of packList) {
				try {
					let set: Set<string>;
					if (cacheContext?.memo?.packOids?.has(key)) {
						set = cacheContext.memo.packOids.get(key)!;
					} else {
						const dataOids = await limiter.run('do:getPackOids', async () => {
							if (!countSubrequest(cacheContext)) {
								logger.warn('soft-budget-exhausted', { op: 'do:getPackOids', key });
								return [] as string[];
							}
							return await stub.getPackOids(key);
						});
						set = new Set((dataOids || []).map((x: string) => x.toLowerCase()));
						if (cacheContext?.memo) {
							cacheContext.memo.packOids = cacheContext.memo.packOids || new Map();
							cacheContext.memo.packOids.set(key, set);
						}
					}
					const has = set.has(oidLc);
					contains[key] = has;
					if (!chosenPackKey && has) chosenPackKey = key;
				} catch {}
			}
			if (!chosenPackKey) chosenPackKey = packList[0];
			if (cacheContext?.memo) {
				cacheContext.memo.flags = cacheContext.memo.flags || new Set();
				if (!cacheContext.memo.flags.has('chosen-pack-logged')) {
					logger.debug('chosen-pack', { chosenPackKey, hasDirectHit: !!contains[chosenPackKey] });
					cacheContext.memo.flags.add('chosen-pack-logged');
				}
			} else {
				logger.debug('chosen-pack', { chosenPackKey, hasDirectHit: !!contains[chosenPackKey] });
			}

			const order: string[] = (() => {
				const array = [...packList];
				if (chosenPackKey) {
					const index = array.indexOf(chosenPackKey);
					if (index > 0) {
						array.splice(index, 1);
						array.unshift(chosenPackKey);
					} else if (index < 0) {
						array.unshift(chosenPackKey);
					}
				}
				const LOAD_MAX = heavyNoCache ? 12 : 20;
				if (array.length > LOAD_MAX) array.length = LOAD_MAX;
				return array;
			})();

			let files: Map<string, Uint8Array>;
			if (cacheContext?.memo?.packFiles) {
				files = cacheContext.memo.packFiles;
			} else {
				files = new Map<string, Uint8Array>();
				if (cacheContext?.memo) cacheContext.memo.packFiles = files;
			}
			const loaded = new Set<string>();
			const BATCH = 5;
			const dir = '/git';
			const baseLoader = createStubLooseLoader(stub);
			const looseLoader = async (oid: string) => {
				if (cacheContext?.memo) {
					const next = (cacheContext.memo.loaderCalls ?? 0) + 1;
					cacheContext.memo.loaderCalls = next;
					const cap = cacheContext.memo.loaderCap ?? LOADER_CAP;
					if (heavyNoCache && next > cap) {
						cacheContext.memo.flags = cacheContext.memo.flags || new Set();
						if (!cacheContext.memo.flags.has('loader-capped')) {
							logger.warn('read:loader-calls-capped', { cap });
							cacheContext.memo.flags.add('loader-capped');
							cacheContext.memo.flags.add('closure-timeout');
						}
						return;
					}
				}
				return await limiter.run('do:getObject', async () => {
					countSubrequest(cacheContext);
					return await baseLoader(oid);
				});
			};
			const fs = createMemPackFs(files, { looseLoader });

			for (let index = 0; index < order.length; index += BATCH) {
				const batch = order.slice(index, index + BATCH).filter((k) => !loaded.has(k));
				await Promise.all(
					batch.map(async (key) => {
						try {
							const base = key.split('/').pop()!;
							const indexBase = base.replace(/\.pack$/i, '.idx');
							if (files.has(`/git/objects/pack/${base}`) && files.has(`/git/objects/pack/${indexBase}`)) {
								loaded.add(key);
								return;
							}
							const ok = await addPackToFiles(environment, key, files);
							if (ok) loaded.add(key);
						} catch {}
					}),
				);
				if (files.size === 0) continue;
				try {
					const result = (await git.readObject({ fs, dir, oid: oidLc, format: 'content' })) as {
						object: Uint8Array;
						type: 'blob' | 'tree' | 'commit' | 'tag';
					};
					if (cacheContext?.memo) {
						cacheContext.memo.flags = cacheContext.memo.flags || new Set();
						if (!cacheContext.memo.flags.has('object-read-logged')) {
							logger.debug('object-read', {
								source: 'r2-packs',
								chosenPackKey,
								packsLoaded: files.size,
								type: result.type,
							});
							cacheContext.memo.flags.add('object-read-logged');
						}
					} else {
						logger.debug('object-read', {
							source: 'r2-packs',
							chosenPackKey,
							packsLoaded: files.size,
							type: result.type,
						});
					}
					if (cacheContext?.memo) {
						cacheContext.memo.objects = cacheContext.memo.objects || new Map();
						cacheContext.memo.objects.set(oidLc, { type: result.type, payload: result.object });
					}
					return { type: result.type, payload: result.object };
				} catch (error) {
					logger.debug('git-readObject-miss', {
						error: String(error),
						oid: oidLc,
						packsTried: files.size,
					});
				}
			}
			return;
		} catch (error) {
			logger.debug('loadFromPacks:error', { error: String(error) });
			return;
		}
	};

	const loadFromState = async (): Promise<{ type: string; payload: Uint8Array } | undefined> => {
		try {
			const z = await limiter.run('do:getObject', async () => {
				if (!countSubrequest(cacheContext)) {
					logger.warn('soft-budget-exhausted', { op: 'do:getObject', oid: oidLc });
					return null;
				}
				return await stub.getObject(oidLc);
			});
			if (z) {
				const parsed = await inflateAndParseHeader(z instanceof Uint8Array ? z : new Uint8Array(z));
				if (parsed) {
					logger.debug('object-read', { source: 'do-state', type: parsed.type });
					return { type: parsed.type, payload: parsed.payload };
				}
			} else {
				logger.debug('do-state-miss', { oid: oidLc });
			}
		} catch (error) {
			logger.debug('do:getObject:error', { error: String(error), oid: oidLc });
			return undefined;
		}
	};

	if (cacheContext) {
		const cacheKey = buildObjectCacheKey(cacheContext.req, repoId, oidLc);
		const bypassCacheRead = cacheContext.memo?.flags?.has('no-cache-read') === true;
		const doLoad = async (): Promise<{ type: string; payload: Uint8Array } | undefined> => {
			if (heavyNoCache) {
				const res = await loadFromPacks();
				if (res && cacheContext?.memo) {
					cacheContext.memo.objects = cacheContext.memo.objects || new Map();
					cacheContext.memo.objects.set(oidLc, res);
				}
				return res;
			}

			const stateResult = await loadFromState();
			if (stateResult) {
				if (cacheContext?.memo) {
					cacheContext.memo.objects = cacheContext.memo.objects || new Map();
					cacheContext.memo.objects.set(oidLc, stateResult);
				}
				return stateResult;
			}

			const res = await loadFromPacks();
			if (res && cacheContext?.memo) {
				cacheContext.memo.objects = cacheContext.memo.objects || new Map();
				cacheContext.memo.objects.set(oidLc, res);
			}
			return res;
		};

		if (!bypassCacheRead) {
			const loaded = await cacheOrLoadObject(cacheKey, doLoad, cacheContext.ctx);
			if (loaded && cacheContext?.memo) {
				cacheContext.memo.objects = cacheContext.memo.objects || new Map();
				cacheContext.memo.objects.set(oidLc, loaded);
			}
			return loaded;
		}

		const loaded = await doLoad();
		if (loaded && !heavyNoCache) {
			try {
				const savePromise = cachePutObject(cacheKey, loaded.type, loaded.payload);
				cacheContext.ctx?.waitUntil?.(savePromise);
			} catch {}
		}
		return loaded;
	}

	{
		const stateResult = await loadFromState();
		if (stateResult) return stateResult;
		return await loadFromPacks();
	}
}
