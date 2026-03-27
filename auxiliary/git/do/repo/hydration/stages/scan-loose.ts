import { getDb as getDatabase, getHydrPendingCounts, insertHydrPendingOids, filterUncoveredAgainstHydrCover } from '../../db/index';
import { handleTransientError } from '../cleanup';
import { clearError, setStage, updateProgress, makeHydrationLogger, nowMs, HYDR_LOOSE_LIST_PAGE } from '../helpers';

import type { HydrationWork } from '../../repo-state';
import type { HydrationCtx as HydrationContext, StageHandlerResult } from '../types';

export async function handleStageScanLoose(context: HydrationContext, work: HydrationWork): Promise<StageHandlerResult> {
	const { state, log, cfg } = context;
	const database = getDatabase(state.storage);
	log.debug('hydration:scan-loose:tick', {
		cursor: work.progress?.looseCursorKey || null,
	});
	const res = await scanLooseSlice(context, work);
	if (res === 'next') {
		setStage(work, 'build-segment', log);
		const counts = await getHydrPendingCounts(database, work.workId);
		log.info('hydration:scan-loose:done', { needLoose: counts.loose });
		clearError(work);
	} else if (res === 'error') {
		await handleTransientError(work, log, cfg);
	} else {
		clearError(work);
	}
	return { continue: true };
}

async function scanLooseSlice(context: HydrationContext, work: HydrationWork): Promise<'more' | 'next' | 'error'> {
	const { state, env, cfg } = context;
	const start = nowMs();
	const log = makeHydrationLogger(env, work.snapshot?.lastPackKey || '');
	const database = getDatabase(state.storage);

	const needLoose = new Set<string>();

	const limit = HYDR_LOOSE_LIST_PAGE;
	let cursor = work.progress?.looseCursorKey || undefined;
	let done = false;

	while (!done && nowMs() - start < cfg.unpackMaxMs) {
		const options: { prefix: string; limit: number; startAfter?: string } = {
			prefix: 'obj:',
			limit,
			...(cursor ? { startAfter: cursor } : {}),
		};
		let it;
		try {
			it = await state.storage.list(options);
		} catch (error) {
			log.warn('scan-loose:list-error', { cursor, error: String(error) });
			work.error = { message: `Failed to list loose objects: ${String(error)}` };
			updateProgress(work, { looseCursorKey: cursor });
			await insertHydrPendingOids(database, work.workId, 'loose', [...needLoose]);
			return 'error';
		}
		const keys: string[] = [];
		for (const k of it.keys()) keys.push(String(k));
		if (keys.length === 0) {
			done = true;
			break;
		}
		const oids = keys.map((k) => String(k).slice(4).toLowerCase());
		let uncovered: string[] = [];
		try {
			uncovered = await filterUncoveredAgainstHydrCover(database, work.workId, oids);
		} catch (error) {
			log.warn('scan-loose:cover-check-failed', { error: String(error) });
			uncovered = oids;
		}
		for (const oid of uncovered) needLoose.add(oid);
		const lastKey = keys.at(-1);
		if (nowMs() - start >= cfg.unpackMaxMs) {
			await insertHydrPendingOids(database, work.workId, 'loose', [...needLoose]);
			updateProgress(work, { looseCursorKey: lastKey });
			log.debug('scan-loose:slice', { added: needLoose.size });
			return 'more';
		}
		cursor = lastKey;
		if (keys.length < limit) {
			const next = await state.storage.list({ prefix: 'obj:', limit: 1, startAfter: cursor });
			const hasMore = next && [...next.keys()].length > 0;
			if (!hasMore) {
				done = true;
				break;
			}
		}
	}

	await insertHydrPendingOids(database, work.workId, 'loose', [...needLoose]);
	if (done) {
		const prog = { ...work.progress, looseCursorKey: undefined };
		work.progress = prog;
		log.info('scan-loose:complete', { needLoose: needLoose.size });
		return 'next';
	}
	updateProgress(work, { looseCursorKey: cursor });
	return 'more';
}
