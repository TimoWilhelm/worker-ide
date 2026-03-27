import { createLogger, getRepoStub } from '@git/common/index';
import { pktLine } from '@git/git/core/index';

import { parseFetchArgs as parseFetchArguments } from '../args';
import { findCommonHaves } from '../closure';
import { resolvePackStream } from '../fetch/execute';
import { planUploadPack } from '../fetch/plan';
import { buildAckOnlyResponse } from '../fetch/protocol';
import { repositoryNotReadyResponse } from '../fetch/responses';
import { SidebandProgressMux, emitProgress, emitFatal, pipePackWithSideband } from '../fetch/sideband';
import { getLimiter, countSubrequest } from '../limits';
import { getPackCandidates } from '../pack-discovery';

import type { CacheContext } from '@git/cache/index';

export * from '../fetch/types';

export async function handleFetchV2Streaming(
	environment: GitWorkerEnvironment,
	repoId: string,
	body: Uint8Array,
	signal?: AbortSignal,
	cacheContext?: CacheContext,
): Promise<Response> {
	const { wants, haves, done } = parseFetchArguments(body);
	const log = createLogger(environment.LOG_LEVEL, { service: 'StreamFetchV2', repoId });

	if (signal?.aborted) {
		return new Response('client aborted\n', { status: 499 });
	}

	if (wants.length === 0) {
		return buildAckOnlyResponse([]);
	}

	if (!done) {
		let ackOids: string[] = [];
		if (haves.length > 0) {
			ackOids = await findCommonHaves(environment, repoId, haves, cacheContext);
			log.debug('stream:fetch:negotiation', { haves: haves.length, acks: ackOids.length });
		}
		return buildAckOnlyResponse(ackOids);
	}

	const stub = getRepoStub(environment, repoId);
	const doId = stub.id.toString();
	const heavy = cacheContext?.memo?.flags?.has('no-cache-read') === true;
	const packKeys = await getPackCandidates(environment, stub, doId, heavy, cacheContext);

	if (packKeys.length === 0) {
		log.warn('stream:fetch:repository-not-ready');
		return repositoryNotReadyResponse();
	}

	log.info('stream:fetch:immediate-stream', { wants: wants.length, haves: haves.length });

	const responseStream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const streamLog = createLogger(environment.LOG_LEVEL, { service: 'StreamFetchV2', repoId });
			try {
				controller.enqueue(pktLine('packfile\n'));
				emitProgress(controller, 'remote: Preparing pack...\n');

				const planStart = Date.now();
				const plan = await planUploadPack(environment, repoId, wants, haves, done, signal, cacheContext);

				if (!plan) {
					emitFatal(controller, 'Unable to create fetch plan');
					controller.close();
					return;
				}

				if (plan.type === 'RepositoryNotReady') {
					emitFatal(controller, 'Repository not ready - objects are being packed');
					controller.close();
					return;
				}

				const planTime = Date.now() - planStart;
				streamLog.info('stream:fetch:plan-complete', { type: plan.type, timeMs: planTime });

				const progressMux = new SidebandProgressMux();
				const limiter = plan.cacheCtx ? getLimiter(plan.cacheCtx) : undefined;

				const packStream = await resolvePackStream(environment, plan, {
					signal: plan.signal,
					limiter,
					countSubrequest: (n?: number) => countSubrequest(plan.cacheCtx, n),
					onProgress: (message) => progressMux.push(message),
				});

				if (!packStream) {
					emitFatal(controller, 'Unable to assemble pack');
					controller.close();
					return;
				}

				await pipePackWithSideband(packStream, controller, {
					signal: plan.signal,
					progressMux,
					log: streamLog,
				});

				controller.close();
			} catch (error) {
				streamLog.error('stream:response:error', { error: String(error) });
				try {
					emitFatal(controller, String(error));
				} catch {}
				controller.error(error);
			}
		},
	});

	return new Response(responseStream, {
		status: 200,
		headers: {
			'Content-Type': 'application/x-git-upload-pack-result',
			'Cache-Control': 'no-cache',
		},
	});
}
