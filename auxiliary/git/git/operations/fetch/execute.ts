import { createLogger, getRepoStub } from '@git/common/index';
import { streamPackFromR2, streamPackFromMultiplePacks } from '@git/git/pack/assembler-stream';

import { getPackCandidates } from '../pack-discovery';
import { getPackCapFromEnv as getPackCapFromEnvironment } from './config';

import type { ResolvedAssemblerPlan } from './types';

export async function resolvePackStream(
	environment: GitWorkerEnvironment,
	plan: ResolvedAssemblerPlan,
	options?: {
		limiter?: { run<T>(label: string, function_: () => Promise<T>): Promise<T> };
		countSubrequest?: (n?: number) => void;
		onProgress?: (message: string) => void;
		signal?: AbortSignal;
	},
): Promise<ReadableStream<Uint8Array> | undefined> {
	const log = createLogger(environment.LOG_LEVEL, { service: 'ResolvePackStream' });
	let packStream: ReadableStream<Uint8Array> | undefined;

	switch (plan.type) {
		case 'InitCloneUnion':
		case 'IncrementalMulti': {
			packStream = await streamPackFromMultiplePacks(environment, plan.packKeys, plan.needed, options);
			break;
		}

		case 'IncrementalSingle': {
			packStream = await streamPackFromR2(environment, plan.packKey, plan.needed, options);

			if (!packStream && plan.cacheCtx) {
				const stub = getRepoStub(environment, plan.repoId);
				const doId = stub.id.toString();
				const heavy = plan.cacheCtx.memo?.flags?.has('no-cache-read') === true;
				const packKeys = await getPackCandidates(environment, stub, doId, heavy, plan.cacheCtx);

				if (packKeys.length >= 2) {
					const packCap = getPackCapFromEnvironment(environment);
					const slice = Math.min(packCap, packKeys.length);
					log.debug('pack-stream:single-fallback-to-multi', { packs: slice });
					packStream = await streamPackFromMultiplePacks(environment, packKeys.slice(0, slice), plan.needed, options);
				}
			}
			break;
		}
	}

	return packStream;
}
