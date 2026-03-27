import { createLogger, getRepoStub } from '@git/common/index';

import { findCommonHaves, buildUnionNeededForKeys, countMissingRootTreesFromWants } from '../closure';
import { beginClosurePhase, endClosurePhase } from '../heavy-mode';
import { getLimiter } from '../limits';
import { getPackCandidates } from '../pack-discovery';
import { getPackCapFromEnv as getPackCapFromEnvironment } from './config';
import { computeNeededFast } from './needed-fast';

import type { AssemblerPlan } from './types';
import type { CacheContext } from '@git/cache/index';

export async function planUploadPack(
	environment: GitWorkerEnvironment,
	repoId: string,
	wants: string[],
	haves: string[],
	done: boolean,
	signal?: AbortSignal,
	cacheContext?: CacheContext,
): Promise<AssemblerPlan | null> {
	const log = createLogger(environment.LOG_LEVEL, { service: 'StreamPlan', repoId });
	const stub = getRepoStub(environment, repoId);
	const doId = stub.id.toString();
	const heavy = cacheContext?.memo?.flags?.has('no-cache-read') === true;
	const packCap = getPackCapFromEnvironment(environment);
	const limiter = getLimiter(cacheContext);

	const packKeys = await getPackCandidates(environment, stub, doId, heavy, cacheContext);

	if (haves.length === 0 && packKeys.length >= 2) {
		let maxKeys = Math.min(packCap, packKeys.length);
		let keys = packKeys.slice(0, maxKeys);
		let unionNeeded = await buildUnionNeededForKeys(stub, keys, limiter, cacheContext, log);

		if (unionNeeded.length > 0) {
			try {
				const unionSet = new Set<string>(unionNeeded);
				const missingRoots = await countMissingRootTreesFromWants(environment, repoId, wants, cacheContext, unionSet);
				if (missingRoots > 0) {
					log.info('stream:plan:init-union:missing-roots', { missingRoots, keys: keys.length });
					maxKeys = packCap;
					keys = packKeys.slice(0, maxKeys);
					unionNeeded = await buildUnionNeededForKeys(stub, keys, limiter, cacheContext, log);
				}
			} catch {}
		}

		if (unionNeeded.length > 0) {
			log.info('stream:plan:init-union', { packs: keys.length, union: unionNeeded.length });
			return {
				type: 'InitCloneUnion',
				repoId,
				packKeys: keys,
				needed: unionNeeded,
				wants,
				ackOids: [],
				signal,
				cacheCtx: cacheContext,
			};
		}
	}

	beginClosurePhase(cacheContext, { loaderCap: 400, doBatchBudget: 20 });
	const needed = await computeNeededFast(environment, repoId, wants, haves, cacheContext);
	endClosurePhase(cacheContext);

	if (cacheContext?.memo?.flags?.has('closure-timeout')) {
		log.warn('stream:plan:closure-timeout', { needed: needed.length });

		if (packKeys.length >= 2) {
			const maxKeys = Math.min(packCap, packKeys.length);
			const keys = packKeys.slice(0, maxKeys);
			const unionNeeded = await buildUnionNeededForKeys(stub, keys, limiter, cacheContext, log);

			if (unionNeeded.length > 0) {
				const ackOids = done ? [] : await findCommonHaves(environment, repoId, haves, cacheContext);
				return {
					type: 'IncrementalMulti',
					repoId,
					packKeys: keys,
					needed: unionNeeded,
					ackOids,
					signal,
					cacheCtx: cacheContext,
				};
			}
		}
		return null;
	}

	const ackOids = done ? [] : await findCommonHaves(environment, repoId, haves, cacheContext);

	if (packKeys.length === 1) {
		log.info('stream:plan:single-pack', {
			packKey: packKeys[0],
			needed: needed.length,
		});

		return {
			type: 'IncrementalSingle',
			repoId,
			packKey: packKeys[0],
			needed,
			ackOids,
			signal,
			cacheCtx: cacheContext,
		};
	}

	if (packKeys.length >= 2) {
		log.info('stream:plan:multi-pack-available', {
			packs: packKeys.length,
			needed: needed.length,
		});

		return {
			type: 'IncrementalSingle',
			repoId,
			packKey: packKeys[0],
			needed,
			ackOids,
			signal,
			cacheCtx: cacheContext,
		};
	}

	log.warn('stream:plan:no-packs-blocking', { needed: needed.length });
	return { type: 'RepositoryNotReady' };
}
