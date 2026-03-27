import { nowMs } from './helpers';
import { getDb as getDatabase, clearHydrCover, clearHydrPending } from '../db/index';

import type { HydrationCtx as HydrationContext, StageHandlerResult } from './types';
import type { HydrationWork } from '../repo-state';

export async function handleStageDone(context: HydrationContext, work: HydrationWork): Promise<StageHandlerResult> {
	const { state, store, log } = context;
	const queue = (await store.get('hydrationQueue')) || [];
	const newQ = Array.isArray(queue) ? queue.slice(1) : [];
	await store.put('hydrationQueue', newQ);
	await store.delete('hydrationWork');
	try {
		const database = getDatabase(state.storage);
		await clearHydrCover(database, work.workId);
		await clearHydrPending(database, work.workId);
	} catch {}
	log.info('done', { remaining: newQ.length });
	return { continue: newQ.length > 0, persist: false };
}

export async function handleStageError(context: HydrationContext, work: HydrationWork): Promise<StageHandlerResult> {
	const { log } = context;
	log.error('error:terminal', { message: work.error?.message, fatal: work.error?.fatal !== false });
	return { continue: false };
}

export async function handleTransientError(work: HydrationWork, log: HydrationContext['log'], cfg: HydrationContext['cfg']): Promise<void> {
	if (!work.error) return;
	work.error.retryCount = (work.error.retryCount || 0) + 1;
	work.error.firstErrorAt = work.error.firstErrorAt || nowMs();
	const intervalMs = Math.max(1000, cfg.unpackBackoffMs || 5000);
	work.error.nextRetryAt = nowMs() + intervalMs;
	log.warn('transient-error:will-retry', {
		message: work.error.message,
		retryCount: work.error.retryCount,
		nextRetryAt: work.error.nextRetryAt,
	});
}
