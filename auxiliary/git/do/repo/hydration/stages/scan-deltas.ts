import { loadIdxParsed } from '@git/git/pack/idx-cache';
import { readPackHeaderEx } from '@git/git/pack/index';

import { getDb as getDatabase, getHydrPendingCounts, insertHydrPendingOids, filterUncoveredAgainstHydrCover } from '../../db/index';
import { handleTransientError } from '../cleanup';
import {
	setStage,
	updateProgress,
	clearError,
	HYDR_SOFT_SUBREQ_LIMIT,
	PACK_TYPE_OFS_DELTA,
	PACK_TYPE_REF_DELTA,
	buildPhysicalIndex,
	makeHydrationLogger,
	nowMs,
} from '../helpers';

import type { HydrationWork } from '../../repo-state';
import type { HydrationCtx as HydrationContext, PackHeaderEx, StageHandlerResult } from '../types';

export async function handleStageScanDeltas(context: HydrationContext, work: HydrationWork): Promise<StageHandlerResult> {
	const { state, log, cfg } = context;
	const database = getDatabase(state.storage);
	log.debug('hydration:scan-deltas:tick', {
		packIndex: work.progress?.packIndex || 0,
		objCursor: work.progress?.objCursor || 0,
		window: work.snapshot?.window?.length || 0,
	});
	const res = await scanDeltasSlice(context, work);
	if (res === 'next') {
		setStage(work, 'scan-loose', log);
		const counts = await getHydrPendingCounts(database, work.workId);
		log.info('hydration:scan-deltas:done', { needBases: counts.bases });
		clearError(work);
	} else if (res === 'error') {
		await handleTransientError(work, log, cfg);
	} else {
		clearError(work);
	}
	return { continue: true };
}

async function scanDeltasSlice(context: HydrationContext, work: HydrationWork): Promise<'more' | 'next' | 'error'> {
	const { state, env, cfg } = context;
	const start = nowMs();
	const log = makeHydrationLogger(env, work.snapshot?.lastPackKey || '');
	const database = getDatabase(state.storage);

	const window = work.snapshot?.window || [];
	if (!window || window.length === 0) return 'next';

	const inPackCoverageCandidates = new Set<string>();
	const needBasesSet = new Set<string>();

	let pIndex = work.progress?.packIndex || 0;
	let objectCurrent = work.progress?.objCursor || 0;
	let subreq = 0;

	while (pIndex < window.length && nowMs() - start < cfg.unpackMaxMs) {
		const key = window[pIndex];
		let parsed;
		try {
			parsed = await loadIdxParsed(env, key);
			subreq++;
		} catch (error) {
			log.warn('scan-deltas:idx-load-error', { key, error: String(error) });
			work.error = { message: `Failed to load pack index: ${String(error)}` };
			updateProgress(work, { packIndex: pIndex, objCursor: objectCurrent });
			await insertHydrPendingOids(database, work.workId, 'base', [...needBasesSet]);
			return 'error';
		}
		if (!parsed) {
			pIndex++;
			objectCurrent = 0;
			log.warn('scan-deltas:missing-idx', { key });
			continue;
		}
		const phys = buildPhysicalIndex(parsed);

		const end = Math.min(phys.sorted.length, objectCurrent + cfg.chunk);
		for (let index = objectCurrent; index < end; index++) {
			const off = phys.sorted[index];
			let header;
			try {
				header = await readPackHeaderEx(env, key, off);
				subreq++;
			} catch (error) {
				log.warn('scan-deltas:header-read-error', { key, off, error: String(error) });
				work.error = { message: `Failed to read pack header: ${String(error)}` };
				objectCurrent = index;
				updateProgress(work, { packIndex: pIndex, objCursor: objectCurrent });
				await insertHydrPendingOids(database, work.workId, 'base', [...needBasesSet]);
				return 'error';
			}
			if (!header) continue;

			const chain = await analyzeDeltaChain(context, key, header, off, phys, (q: string) => {
				if (phys.oidsSet.has(q)) inPackCoverageCandidates.add(q);
				return false;
			});
			for (const oid of chain) needBasesSet.add(oid);

			if (nowMs() - start >= cfg.unpackMaxMs || subreq >= HYDR_SOFT_SUBREQ_LIMIT) {
				objectCurrent = index + 1;
				try {
					const uncovered = await filterUncoveredAgainstHydrCover(database, work.workId, [...inPackCoverageCandidates]);
					const uncoveredSet = new Set(uncovered);
					for (const q of inPackCoverageCandidates) {
						if (!uncoveredSet.has(q)) needBasesSet.delete(q);
					}
				} catch {}
				updateProgress(work, { packIndex: pIndex, objCursor: objectCurrent });
				await insertHydrPendingOids(database, work.workId, 'base', [...needBasesSet]);
				log.debug('scan-deltas:slice', {
					packIndex: pIndex,
					advanced: index - (work.progress?.objCursor || 0),
					needBases: needBasesSet.size,
				});
				return 'more';
			}
		}
		objectCurrent = end;
		if (objectCurrent >= phys.sorted.length) {
			pIndex++;
			objectCurrent = 0;
		} else {
			updateProgress(work, { packIndex: pIndex, objCursor: objectCurrent });
			await insertHydrPendingOids(database, work.workId, 'base', [...needBasesSet]);
			log.debug('scan-deltas:continue', {
				packIndex: pIndex,
				objCursor: objectCurrent,
				needBases: needBasesSet.size,
			});
			return 'more';
		}
	}

	try {
		const uncovered = await filterUncoveredAgainstHydrCover(database, work.workId, [...inPackCoverageCandidates]);
		const uncoveredSet = new Set(uncovered);
		for (const q of inPackCoverageCandidates) {
			if (!uncoveredSet.has(q)) needBasesSet.delete(q);
		}
	} catch {}
	updateProgress(work, { packIndex: pIndex, objCursor: objectCurrent });
	await insertHydrPendingOids(database, work.workId, 'base', [...needBasesSet]);
	log.info('scan-deltas:complete', { needBases: needBasesSet.size });
	return pIndex < window.length ? 'more' : 'next';
}

async function analyzeDeltaChain(
	context: HydrationContext,
	packKey: string,
	header: PackHeaderEx,
	off: number,
	index: { offToIdx: Map<number, number>; oids: string[]; offsets: number[]; oidsSet: Set<string> },
	coveredHas: (q: string) => boolean,
): Promise<string[]> {
	const chain: string[] = [];
	const seen = new Set<string>();
	let baseOid: string | undefined;
	let currentOff = off;
	let currentHeader = header;

	while (true) {
		baseOid = undefined;

		if (currentHeader.type === PACK_TYPE_OFS_DELTA) {
			const baseOff = currentOff - (currentHeader.baseRel || 0);
			const baseIndex = index.offToIdx.get(baseOff);
			if (baseIndex !== undefined) baseOid = index.oids[baseIndex];
			currentOff = baseOff;
		} else if (currentHeader.type === PACK_TYPE_REF_DELTA) {
			baseOid = currentHeader.baseOid;
			if (baseOid) {
				const searchOid = baseOid.toLowerCase();
				const baseIndex = index.oids.findIndex((o) => o.toLowerCase() === searchOid);
				if (baseIndex === -1) {
					if (!coveredHas(searchOid) && !seen.has(searchOid)) {
						chain.push(searchOid);
					}
					break;
				} else {
					currentOff = index.offsets[baseIndex];
				}
			}
		}

		if (!baseOid) break;

		const q = baseOid.toLowerCase();
		if (seen.has(q)) break;
		seen.add(q);

		if (!index.oidsSet.has(q) || !coveredHas(q)) {
			chain.push(q);
			if (!index.oidsSet.has(q)) break;
		}

		try {
			const nextHeader = await readPackHeaderEx(context.env, packKey, currentOff);
			if (!nextHeader) break;
			if (nextHeader.type !== PACK_TYPE_OFS_DELTA && nextHeader.type !== PACK_TYPE_REF_DELTA) {
				break;
			}
			currentHeader = nextHeader;
		} catch {
			break;
		}
	}

	return chain;
}
