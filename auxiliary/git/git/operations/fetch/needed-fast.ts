import { getRepoStub, createLogger } from '@git/common/index';
import { parseCommitRefs, parseTreeChildOids, parseTagTarget } from '@git/git/core/index';

import { findCommonHaves } from '../closure';
import { getLimiter, countSubrequest } from '../limits';
import { readLooseObjectRaw } from '../read/index';

import type { CacheContext } from '@git/cache/index';

export async function computeNeededFast(
	environment: GitWorkerEnvironment,
	repoId: string,
	wants: string[],
	haves: string[],
	cacheContext?: CacheContext,
): Promise<string[]> {
	const log = createLogger(environment.LOG_LEVEL, { service: 'NeededFast', repoId });
	const stub = getRepoStub(environment, repoId);
	const limiter = getLimiter(cacheContext);
	const startTime = Date.now();

	log.debug('fast:building-stop-set', { haves: haves.length });
	const stopSet = new Set<string>();
	const timeout = 49_000;

	let ackOids: string[] = [];
	if (haves.length > 0) {
		ackOids = await findCommonHaves(environment, repoId, haves.slice(0, 128), cacheContext);
		for (const oid of ackOids) {
			stopSet.add(oid.toLowerCase());
		}

		if (ackOids.length === 0) {
			log.debug('fast:no-common-base', { haves: haves.length });
		}
	}

	if (ackOids.length > 0 && ackOids.length < 10) {
		const MAINLINE_BUDGET = 20;
		const mainlineQueue = [...ackOids];
		let mainlineCount = 0;

		while (mainlineQueue.length > 0 && mainlineCount < MAINLINE_BUDGET) {
			if (Date.now() - startTime > 2000) break;

			const oid = mainlineQueue.shift()!;
			try {
				const object = await readLooseObjectRaw(environment, repoId, oid, cacheContext);
				if (object?.type === 'commit') {
					const references = parseCommitRefs(object.payload);
					if (references.parents && references.parents.length > 0) {
						const parent = references.parents[0];
						if (!stopSet.has(parent)) {
							stopSet.add(parent);
							mainlineQueue.push(parent);
							mainlineCount++;
						}
					}
				}
			} catch {}
		}

		log.debug('fast:mainline-enriched', { stopSize: stopSet.size, walked: mainlineCount });
	}

	const seen = new Set<string>();
	const needed = new Set<string>();
	const queue = [...wants];

	if (cacheContext) {
		cacheContext.memo = cacheContext.memo || {};
		cacheContext.memo.refs = cacheContext.memo.refs || new Map<string, string[]>();
		cacheContext.memo.flags = cacheContext.memo.flags || new Set<string>();
	}

	let doBatchBudget = cacheContext?.memo?.doBatchBudget ?? 20;
	let doBatchDisabled = cacheContext?.memo?.doBatchDisabled ?? false;
	let doBatchCalls = 0;
	let memoReferencesHits = 0;
	let fallbackReads = 0;

	log.info('fast:starting-closure', { wants: wants.length, stopSet: stopSet.size });

	while (queue.length > 0) {
		if (Date.now() - startTime > timeout) {
			log.warn('fast:timeout', { seen: seen.size, needed: needed.size });
			if (cacheContext) {
				cacheContext.memo = cacheContext.memo || {};
				cacheContext.memo.flags = cacheContext.memo.flags || new Set<string>();
				cacheContext.memo.flags.add('closure-timeout');
			}
			break;
		}

		if (cacheContext?.memo?.flags?.has('loader-capped')) {
			log.warn('fast:loader-capped', { seen: seen.size, needed: needed.size });
			if (cacheContext) {
				cacheContext.memo = cacheContext.memo || {};
				cacheContext.memo.flags = cacheContext.memo.flags || new Set<string>();
				cacheContext.memo.flags.add('closure-timeout');
			}
			break;
		}

		const batchSize = Math.min(128, queue.length);
		const batch = queue.splice(0, batchSize);
		const unseenBatch = batch.filter((oid) => !seen.has(oid));

		if (unseenBatch.length === 0) continue;

		const toProcess: string[] = [];
		for (const oid of unseenBatch) {
			seen.add(oid);
			const lc = oid.toLowerCase();

			if (stopSet.has(lc)) {
				log.debug('fast:hit-stop', { oid });
				continue;
			}

			needed.add(oid);
			toProcess.push(oid);
		}

		if (toProcess.length === 0) continue;

		const referencesMap: Map<string, string[]> = new Map();

		if (cacheContext?.memo?.refs) {
			for (const oid of toProcess) {
				const lc = oid.toLowerCase();
				const cached = cacheContext.memo.refs.get(lc);
				if (cached && cached.length >= 0) {
					referencesMap.set(oid, cached);
					memoReferencesHits++;
				}
			}
		}

		const toBatch = toProcess.filter((oid) => !referencesMap.has(oid));
		if (toBatch.length > 0 && !doBatchDisabled && doBatchBudget > 0) {
			try {
				const batchMap = await limiter.run('do:getObjectRefsBatch', async () => {
					countSubrequest(cacheContext);
					return await stub.getObjectRefsBatch(toBatch);
				});
				doBatchBudget--;
				doBatchCalls++;

				for (const [oid, references] of batchMap) {
					const lc = oid.toLowerCase();
					if (references && references.length >= 0) {
						referencesMap.set(oid, references);
						if (cacheContext?.memo) {
							cacheContext.memo.refs = cacheContext.memo.refs || new Map<string, string[]>();
							cacheContext.memo.refs.set(lc, references);
						}
					}
				}
			} catch (error) {
				log.debug('fast:batch-error', { error: String(error) });
				doBatchDisabled = true;
			}
		}

		const stillMissing = toProcess.filter((oid) => !referencesMap.has(oid));
		if (stillMissing.length > 0) {
			const CONC = 4;
			let index = 0;
			const workers: Promise<void>[] = [];

			const fetchOne = async () => {
				while (index < stillMissing.length) {
					const oid = stillMissing[index++];
					fallbackReads++;

					try {
						const object = await readLooseObjectRaw(environment, repoId, oid, cacheContext);
						if (!object) continue;

						const references: string[] = [];
						switch (object.type) {
							case 'commit': {
								const commitReferences = parseCommitRefs(object.payload);
								if (commitReferences.tree) references.push(commitReferences.tree);
								if (commitReferences.parents) references.push(...commitReferences.parents);

								break;
							}
							case 'tree': {
								const childOids = parseTreeChildOids(object.payload);
								references.push(...childOids);

								break;
							}
							case 'tag': {
								const tagInfo = parseTagTarget(object.payload);
								if (tagInfo?.targetOid) references.push(tagInfo.targetOid);

								break;
							}
							// No default
						}

						referencesMap.set(oid, references);
						if (cacheContext?.memo) {
							const lc = oid.toLowerCase();
							cacheContext.memo.refs = cacheContext.memo.refs || new Map<string, string[]>();
							cacheContext.memo.refs.set(lc, references);
						}
					} catch {}
				}
			};

			for (let c = 0; c < CONC; c++) workers.push(fetchOne());
			await Promise.all(workers);
		}

		for (const [_oid, references] of referencesMap) {
			for (const reference of references) {
				if (!seen.has(reference)) {
					queue.push(reference);
				}
			}
		}
	}

	if (cacheContext?.memo) {
		cacheContext.memo.doBatchBudget = doBatchBudget;
		cacheContext.memo.doBatchDisabled = doBatchDisabled;
	}

	const elapsed = Date.now() - startTime;
	log.info('fast:completed', {
		needed: needed.size,
		seen: seen.size,
		stopSet: stopSet.size,
		memoHits: memoReferencesHits,
		doBatches: doBatchCalls,
		fallbacks: fallbackReads,
		timeMs: elapsed,
	});

	return [...needed];
}
