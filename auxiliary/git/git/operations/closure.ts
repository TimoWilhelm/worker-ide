import { createLogger, getRepoStub } from '@git/common/index';
import { parseCommitRefs } from '@git/git/core/index';

import { getLimiter, countSubrequest } from './limits';
import { readLooseObjectRaw } from './read/index';

import type { CacheContext } from '@git/cache/index';
import type { RepoDurableObject } from '@git/index';

/**
 * Finds common commits between server and client.
 * Used for negotiation in fetch protocol.
 *
 * @param env - Worker environment
 * @param repoId - Repository identifier
 * @param haves - List of commit OIDs the client claims to have
 * @param cacheCtx - Optional cache context for request memoization and subrequest accounting
 * @returns Array of OIDs that both client and server have
 */
export async function findCommonHaves(
	environment: GitWorkerEnvironment,
	repoId: string,
	haves: string[],
	cacheContext?: CacheContext,
): Promise<string[]> {
	const stub = getRepoStub(environment, repoId);
	const limiter = getLimiter(cacheContext);
	const limit = 128;
	const cappedHaves = haves.slice(0, limit);
	const doData = await limiter.run('do:hasLooseBatch', async () => {
		countSubrequest(cacheContext);
		return await stub.hasLooseBatch(cappedHaves);
	});

	// hasLooseBatch returns a boolean array indicating which OIDs exist
	if (doData && Array.isArray(doData) && doData.length === cappedHaves.length) {
		const found: string[] = [];
		for (const [index, doDatum] of doData.entries()) {
			if (doDatum) found.push(cappedHaves[index]);
		}
		if (found.length > 0) return found;
	}

	// Fall back to R2 checks if DO returns empty
	const log = createLogger(environment.LOG_LEVEL, { service: 'FindCommonHaves', repoId });
	const candidates = cappedHaves.slice(0, 16);
	const found: string[] = [];

	for (const have of candidates) {
		try {
			const object = await readLooseObjectRaw(environment, repoId, have, cacheContext);
			if (object) found.push(have);
		} catch {}
	}

	log.debug('common:haves:fallback', { tried: candidates.length, found: found.length });
	return found;
}

/**
 * Builds a union of object IDs from multiple pack files.
 * Used for initial clone operations when client has no objects.
 * Returns ALL objects from the selected packs (thick pack) to avoid closure computation.
 *
 * @param stub - Durable Object stub for the repository
 * @param keys - Array of pack file keys to union
 * @param limiter - Request limiter for concurrency control
 * @param cacheCtx - Optional CacheContext for subrequest accounting
 * @param log - Logger-like object for debug logging
 */
export async function buildUnionNeededForKeys(
	stub: DurableObjectStub<RepoDurableObject>,
	keys: string[],
	limiter: { run<T>(name: string, function_: () => Promise<T>): Promise<T> },
	cacheContext: CacheContext | undefined,
	log: { debug: (message: string, data?: any) => void; warn: (message: string, data?: any) => void },
) {
	const doUnion = new Set<string>();

	if (keys.length === 0) {
		return [...doUnion];
	}

	const DO_BATCH_MIN = 10;
	const DO_BATCH_MAX = 100;
	const sliceSize = Math.min(DO_BATCH_MAX, Math.max(DO_BATCH_MIN, keys.length));
	const sampleKeys = keys.slice(0, sliceSize);

	try {
		countSubrequest(cacheContext);
		const oidsBatch = await limiter.run('do:getPackOidsBatch', async () => {
			countSubrequest(cacheContext, 1);
			return await stub.getPackOidsBatch(sampleKeys);
		});

		if (oidsBatch && oidsBatch.size > 0) {
			log.debug('union:do-batch', {
				requestedKeys: sampleKeys.length,
				returnedKeys: oidsBatch.size,
			});

			for (const oids of oidsBatch.values()) {
				for (const oid of oids) {
					doUnion.add(oid);
				}
			}
		} else {
			log.warn('union:do-batch:empty', { keys: sampleKeys.length });
		}
	} catch (error) {
		log.warn('union:do-batch:error', { error: String(error) });

		// Fallback: query each pack individually
		for (let index = 0; index < Math.min(sliceSize, keys.length); index++) {
			try {
				const oids = await limiter.run('do:getPackOids', async () => {
					countSubrequest(cacheContext);
					return await stub.getPackOids(keys[index]);
				});
				if (oids && oids.length > 0) {
					for (const oid of oids) doUnion.add(oid);
				}
			} catch (error) {
				log.warn('union:do-single:error', { key: keys[index], error: String(error) });
			}
		}
	}

	// Return the full union of all objects from the packs
	// The union path is for initial clones and should include all objects (thick pack)
	// Do not filter by wants - the whole point is to avoid closure computation
	return [...doUnion];
}

/**
 * Counts how many wanted commits have a root tree missing from a membership set.
 * Used for coverage validation to ensure pack contains all necessary objects.
 *
 * @param env - Worker environment
 * @param repoId - Repository identifier
 * @param wants - List of wanted commit OIDs
 * @param cacheCtx - Optional CacheContext
 * @param membershipSet - Set of OIDs that will be in the pack
 * @returns Number of commits with missing root trees
 */
export async function countMissingRootTreesFromWants(
	environment: GitWorkerEnvironment,
	repoId: string,
	wants: string[],
	cacheContext: CacheContext | undefined,
	membershipSet: Set<string>,
): Promise<number> {
	const log = createLogger(environment.LOG_LEVEL, { service: 'RootTreeCheck', repoId });
	const CHECK_MAX = Math.min(16, wants.length);
	let missingCount = 0;
	const checked: string[] = [];

	for (const wantOid of wants.slice(0, CHECK_MAX)) {
		try {
			const object = await readLooseObjectRaw(environment, repoId, wantOid, cacheContext);
			if (object && object.type === 'commit') {
				const references = parseCommitRefs(object.payload);
				if (references.tree && !membershipSet.has(references.tree)) {
					missingCount++;
					log.debug('root-tree:missing', { commit: wantOid, tree: references.tree });
				}
				checked.push(wantOid);
			}
		} catch (error) {
			log.debug('root-tree:check-error', { commit: wantOid, error: String(error) });
		}
	}

	log.debug('root-tree:check', {
		wants: wants.length,
		checked: checked.length,
		missingTrees: missingCount,
	});

	return missingCount;
}
