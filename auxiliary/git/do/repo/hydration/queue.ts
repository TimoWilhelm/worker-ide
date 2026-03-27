import { createLogger } from '@git/common/index';

import { asTypedStorage } from '../repo-state';
import { nowMs } from './helpers';
import { ensureScheduled } from '../scheduler';

import type { RepoStateSchema, HydrationTask, HydrationReason } from '../repo-state';

export async function enqueueHydrationTask(
	state: DurableObjectState,
	environment: GitWorkerEnvironment,
	options?: { dryRun?: boolean; reason?: HydrationReason },
): Promise<{ queued: boolean; workId: string; queueLength: number }> {
	const store = asTypedStorage<RepoStateSchema>(state.storage);
	const log = createLogger(environment.LOG_LEVEL, { service: 'Hydration' });
	const q = (await store.get('hydrationQueue')) || [];
	const reason = options?.reason || 'admin';
	const exists = Array.isArray(q) && q.some((t: HydrationTask) => t?.reason === reason);
	const queue: HydrationTask[] = Array.isArray(q) ? [...q] : [];
	const workId = `hydr-${nowMs()}`;
	if (exists) {
		log.info('enqueue:dedupe', { queueLength: queue.length, reason });
	} else {
		queue.push({ reason, createdAt: nowMs(), options: { dryRun: options?.dryRun } });
		await store.put('hydrationQueue', queue);
		await ensureScheduled(state, environment);
		log.info('enqueue:ok', { queueLength: queue.length, reason });
	}
	return { queued: true, workId, queueLength: queue.length };
}
