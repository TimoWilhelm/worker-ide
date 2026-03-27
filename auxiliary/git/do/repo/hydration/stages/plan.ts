import { buildRecentWindowKeys, ensureHydrCoverForWork, setStage } from '../helpers';
import { summarizeHydrationPlan } from '../status';

import type { HydrationWork } from '../../repo-state';
import type { HydrationCtx as HydrationContext, StageHandlerResult } from '../types';

export async function handleStagePlan(context: HydrationContext, work: HydrationWork): Promise<StageHandlerResult> {
	const { store, cfg, log } = context;
	const lastPackKey = (await store.get('lastPackKey')) || null;
	const packListRaw = (await store.get('packList')) || [];
	const packList = Array.isArray(packListRaw) ? packListRaw : [];
	const window = buildRecentWindowKeys(lastPackKey, packList, cfg.windowMax);

	work.snapshot = {
		lastPackKey,
		packList: packList.slice(0, cfg.windowMax),
		window,
	};
	work.progress = { ...work.progress, packIndex: 0, objCursor: 0 };

	try {
		await ensureHydrCoverForWork(context.state, store, cfg, work.workId);
	} catch (error) {
		log.warn('hydration:cover:init-failed', { error: String(error) });
	}

	if (work.dryRun) {
		try {
			const summary = await summarizeHydrationPlan(context.state, context.env, context.prefix);
			log.info('hydration:dry-run:summary', { summary });
		} catch (error) {
			log.warn('hydration:dry-run:summary-failed', { error: String(error) });
		}
		setStage(work, 'done', log);
		log.info('hydration:planned(dry-run)', { window: window.length, last: lastPackKey });
		return { continue: true };
	}

	setStage(work, 'scan-deltas', log);
	log.info('hydration:planned', { window: window.length, last: lastPackKey });
	return { continue: true };
}
