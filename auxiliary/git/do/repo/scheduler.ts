import { createLogger } from '@git/common/index';

import { getConfig } from './repo-config';
import { asTypedStorage } from './repo-state';

import type { RepoStateSchema } from './repo-state';

/**
 * Plan the next alarm time purely from existing DO state and repo config.
 * Priority: unpack > hydration > min(idle, maintenance).
 */
async function planNextAlarm(
	state: DurableObjectState,
	environment: GitWorkerEnvironment,
	now = Date.now(),
): Promise<{ when: number; reason: 'unpack' | 'hydration' | 'idle' | 'maint' } | null> {
	const log = createLogger(environment.LOG_LEVEL, { service: 'Scheduler', doId: state.id.toString() });
	const store = asTypedStorage<RepoStateSchema>(state.storage);
	const cfg = getConfig(environment);

	// 1) Unpack has highest priority
	try {
		const [unpackWork, unpackNext] = await Promise.all([store.get('unpackWork'), store.get('unpackNext')]);
		if (unpackWork || unpackNext) {
			return { when: now + cfg.unpackDelayMs, reason: 'unpack' };
		}
	} catch (error) {
		log.warn('sched:read-unpack-state-failed', { error: String(error) });
	}

	// 2) Hydration next
	try {
		const [hydrWork, hydrQueue] = await Promise.all([store.get('hydrationWork'), store.get('hydrationQueue')]);
		const hasQueue = Array.isArray(hydrQueue) ? hydrQueue.length > 0 : !!hydrQueue;

		if (hydrWork) {
			if (hydrWork.stage === 'error') {
				const fatal = !!hydrWork.error?.fatal;
				log.warn(fatal ? 'sched:hydration-fatal-error' : 'sched:hydration-terminal-error', {
					message: hydrWork.error?.message,
				});
			} else {
				const nextRetryAt = hydrWork.error?.nextRetryAt;
				if (typeof nextRetryAt === 'number' && nextRetryAt > now) {
					return { when: nextRetryAt, reason: 'hydration' };
				}
				return { when: now + cfg.unpackDelayMs, reason: 'hydration' };
			}
		} else if (hasQueue) {
			return { when: now + cfg.unpackDelayMs, reason: 'hydration' };
		}
	} catch (error) {
		log.warn('sched:read-hydration-state-failed', { error: String(error) });
	}

	// 3) Idle / Maintenance planning
	try {
		const [lastAccess, lastMaint] = await Promise.all([store.get('lastAccessMs'), store.get('lastMaintenanceMs')]);
		const nextIdleAt = (lastAccess ?? now) + cfg.idleMs;
		const nextMaintAt = (lastMaint ?? now) + cfg.maintMs;
		const candidateIdle = nextIdleAt <= now ? now + cfg.idleMs : nextIdleAt;
		const candidateMaint = nextMaintAt <= now ? now + cfg.maintMs : nextMaintAt;
		const when = Math.min(candidateIdle, candidateMaint);
		const reason = candidateMaint <= candidateIdle ? 'maint' : 'idle';
		return { when, reason };
	} catch (error) {
		log.error('sched:plan-idle-maint-failed', { error: String(error) });
		return null;
	}
}

/**
 * Set the DO alarm only if this would fire sooner than the existing one.
 */
export async function scheduleAlarmIfSooner(
	state: DurableObjectState,
	environment: GitWorkerEnvironment,
	when: number,
	now = Date.now(),
): Promise<{ scheduled: boolean; prev: number | null; next: number }> {
	const log = createLogger(environment.LOG_LEVEL, { service: 'Scheduler', doId: state.id.toString() });
	let previous: number | null = null;
	try {
		previous = (await state.storage.getAlarm()) as number | null;
	} catch (error) {
		log.warn('sched:get-alarm-failed', { error: String(error) });
		previous = null;
	}

	// Avoid redundant reset to the same timestamp (even if in the past)
	if (previous !== null && previous === when) {
		return { scheduled: false, prev: previous, next: previous };
	}

	if (!previous || previous < now || previous > when) {
		try {
			await state.storage.setAlarm(when);
			log.debug('sched:set-alarm', { when });
			return { scheduled: true, prev: previous ?? null, next: when };
		} catch (error) {
			log.error('sched:set-alarm-failed', { error: String(error), when });
			return { scheduled: false, prev: previous ?? null, next: previous ?? when };
		}
	}
	return { scheduled: false, prev: previous ?? null, next: previous };
}

/**
 * Compute and schedule in one step. No-ops if nothing to schedule.
 */
export async function ensureScheduled(
	state: DurableObjectState,
	environment: GitWorkerEnvironment,
	now = Date.now(),
): Promise<{
	scheduled: boolean;
	when?: number;
	reason?: 'unpack' | 'hydration' | 'idle' | 'maint';
}> {
	const log = createLogger(environment.LOG_LEVEL, { service: 'Scheduler', doId: state.id.toString() });
	try {
		const plan = await planNextAlarm(state, environment, now);
		if (!plan) return { scheduled: false };
		// Clamp to a near-future time to avoid repeatedly scheduling past alarms
		const targetWhen = Math.max(plan.when, now + 5);
		const res = await scheduleAlarmIfSooner(state, environment, targetWhen, now);
		if (res.scheduled) {
			log.debug('sched:alarm-set', { when: res.next, reason: plan.reason });
		}
		return { scheduled: res.scheduled, when: res.next, reason: plan.reason };
	} catch (error) {
		log.error('sched:ensure-failed', { error: String(error) });
		return { scheduled: false };
	}
}
