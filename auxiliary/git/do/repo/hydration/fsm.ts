import { asTypedStorage } from '../repo-state';
import { ensureScheduled } from '../scheduler';
import { handleStageDone, handleStageError } from './cleanup';
import { getHydrConfig, makeHydrationLogger, nowMs } from './helpers';
import { handleStageBuildSegment } from './stages/build-segment';
import { handleStagePlan } from './stages/plan';
import { handleStageScanDeltas } from './stages/scan-deltas';
import { handleStageScanLoose } from './stages/scan-loose';

import type { RepoStateSchema, HydrationStage } from '../repo-state';
import type { HydrationCtx as HydrationContext, StageHandler } from './types';

const STAGE_HANDLERS: Record<HydrationStage, StageHandler> = {
	plan: handleStagePlan,
	'scan-deltas': handleStageScanDeltas,
	'scan-loose': handleStageScanLoose,
	'build-segment': handleStageBuildSegment,
	done: handleStageDone,
	error: handleStageError,
};

export async function processHydrationSlice(
	state: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
): Promise<boolean> {
	const store = asTypedStorage<RepoStateSchema>(state.storage);
	const log = makeHydrationLogger(environment, prefix);
	const cfg = getHydrConfig(environment);

	let work = (await store.get('hydrationWork')) || undefined;
	const queue = (await store.get('hydrationQueue')) || [];

	if (!work) {
		if (!Array.isArray(queue) || queue.length === 0) return false;
		const task = queue[0];
		work = {
			workId: `hydr-${nowMs()}`,
			startedAt: nowMs(),
			dryRun: !!task?.options?.dryRun,
			stage: 'plan',
			progress: { packIndex: 0, objCursor: 0, segmentSeq: 0, producedBytes: 0 },
			stats: {},
		};
		await store.put('hydrationWork', work);
		await ensureScheduled(state, environment);
		log.info('hydration:start', {
			stage: work.stage,
			reason: task?.reason || '?',
		});
		return true;
	}

	const context: HydrationContext = { state, env: environment, prefix, store, cfg, log };
	const handler = STAGE_HANDLERS[work.stage] as StageHandler | undefined;
	if (!handler) {
		await store.delete('hydrationWork');
		log.warn('reset:unknown-stage', {});
		return false;
	}

	const result = await handler(context, work);
	if (result.persist !== false) {
		await store.put('hydrationWork', work);
	}
	if (result.continue) {
		await ensureScheduled(state, environment);
	}
	return result.continue;
}
