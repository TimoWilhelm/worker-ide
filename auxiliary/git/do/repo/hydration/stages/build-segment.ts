import { inflateAndParseHeader } from '@git/git/core/index';
import { buildPackV2, indexPackOnly } from '@git/git/pack/index';
import { r2PackKey } from '@git/keys';

import {
	getDb as getDatabase,
	getHydrPendingCounts,
	getHydrPendingOids,
	filterUncoveredAgainstHydrCover,
	insertPackOids,
	insertHydrCoverOids,
	deleteHydrPendingOids,
} from '../../db/index';
import { getEpochFromWorkId } from '../../packs';
import { objKey as objectKey } from '../../repo-state';
import { handleTransientError } from '../cleanup';
import {
	clearError,
	setStage,
	updateProgress,
	HYDR_MAX_OBJS_PER_SEGMENT,
	HYDR_SEG_MAX_BYTES,
	HYDR_EST_COMPRESSION_RATIO,
	makeHydrationLogger,
} from '../helpers';

import type { HydrationWork } from '../../repo-state';
import type { HydrationCtx as HydrationContext, StageHandlerResult } from '../types';
import type { GitObjectType } from '@git/git/core/index';

export async function handleStageBuildSegment(context: HydrationContext, work: HydrationWork): Promise<StageHandlerResult> {
	const { state, log, cfg } = context;
	const database = getDatabase(state.storage);
	const counts = await getHydrPendingCounts(database, work.workId);
	log.info('hydration:build-segment:tick', {
		needBases: counts.bases,
		needLoose: counts.loose,
		segmentSeq: work.progress?.segmentSeq || 0,
	});
	const res = await buildSegmentSlice(context, work);
	if (res === 'done') {
		setStage(work, 'done', log);
		log.info('hydration:build-segment:done', {
			segmentSeq: work.progress?.segmentSeq || 0,
			producedBytes: work.progress?.producedBytes || 0,
		});
		return { continue: true };
	}
	if (res === 'error') {
		if (work.error?.fatal) {
			setStage(work, 'error', log);
			log.error('hydration:fatal-error', { message: work.error.message });
			return { continue: false };
		}
		await handleTransientError(work, log, cfg);
	}
	if (res !== 'error') clearError(work);
	return { continue: true };
}

async function buildSegmentSlice(context: HydrationContext, work: HydrationWork): Promise<'more' | 'done' | 'error'> {
	const { state, env, prefix, store } = context;
	const database = getDatabase(state.storage);
	const log = makeHydrationLogger(env, prefix);

	const maxFetch = HYDR_MAX_OBJS_PER_SEGMENT * 2;
	const needBases = await getHydrPendingOids(database, work.workId, 'base', maxFetch);
	const needLoose = await getHydrPendingOids(database, work.workId, 'loose', maxFetch);
	const candidatesRaw = [...new Set<string>([...needBases, ...needLoose])];

	let candidates: string[] = [];
	try {
		candidates = await filterUncoveredAgainstHydrCover(database, work.workId, candidatesRaw);
	} catch {
		candidates = candidatesRaw.map((x) => String(x).toLowerCase());
	}
	if (candidates.length === 0) {
		log.info('build:empty-pending', {});
		return 'done';
	}

	const batch: string[] = [];
	const objs: { type: GitObjectType; payload: Uint8Array; oid: string }[] = [];
	const missing: string[] = [];
	let estBytes = 0;

	for (const oid of candidates) {
		const z = await state.storage.get(objectKey(oid));
		if (!(z instanceof Uint8Array) && !(z instanceof ArrayBuffer)) {
			missing.push(oid);
			continue;
		}
		try {
			const buf = z instanceof Uint8Array ? z : new Uint8Array(z);
			const parsed = await inflateAndParseHeader(buf);
			if (!parsed) continue;
			const est = Math.ceil(parsed.payload.byteLength * HYDR_EST_COMPRESSION_RATIO) + 32;
			if (objs.length < HYDR_MAX_OBJS_PER_SEGMENT && (estBytes + est <= HYDR_SEG_MAX_BYTES || objs.length === 0)) {
				objs.push({ type: parsed.type, payload: parsed.payload, oid });
				batch.push(oid);
				estBytes += est;
			}
		} catch (error) {
			log.debug('build:parse-failed', { oid, error: String(error) });
		}
		if (objs.length >= HYDR_MAX_OBJS_PER_SEGMENT || estBytes >= HYDR_SEG_MAX_BYTES) break;
	}

	if (missing.length > 0) {
		log.error('build:missing-loose', { count: missing.length, sample: missing.slice(0, 10) });
		work.error = {
			message: `missing ${missing.length} loose objects in DO`,
			fatal: true,
		};
		return 'error';
	}

	if (objs.length === 0) {
		log.warn('build:no-objects-loaded', {});
		return 'done';
	}

	const packfile = await buildPackV2(objs.map(({ type, payload }) => ({ type, payload })));

	const seq = (work.progress?.segmentSeq ?? 0) + 1;
	const epoch = getEpochFromWorkId(work.workId);
	const packKey = r2PackKey(prefix, `pack-hydr-${epoch}-${seq}.pack`);

	try {
		await env.REPO_BUCKET.put(packKey, packfile);
		log.info('build:stored-pack', { packKey, bytes: packfile.byteLength, objects: objs.length });
	} catch (error) {
		log.warn('build:store-pack-failed', { packKey, error: String(error) });
		work.error = { message: `Failed to store pack to R2: ${String(error)}` };
		return 'error';
	}

	const builtOids = objs.map((o) => o.oid);
	try {
		await insertPackOids(database, packKey, builtOids);
	} catch (error) {
		log.warn('build:store-oids-failed', { packKey, error: String(error) });
	}

	let oids: string[] = [];
	try {
		oids = await indexPackOnly(packfile, env, packKey, state, prefix);
		if (oids.length > 0) {
			log.info('build:updated-packOids', { packKey, count: oids.length });
			await insertPackOids(database, packKey, oids);
		}
	} catch (error) {
		log.warn('build:index-failed', { packKey, error: String(error) });
	}

	try {
		const all = new Set<string>();
		for (const x of builtOids) all.add(String(x).toLowerCase());
		for (const x of oids) all.add(String(x).toLowerCase());
		await insertHydrCoverOids(database, work.workId, [...all]);
	} catch (error) {
		log.debug('build:update-hydr_cover-failed', { error: String(error) });
	}

	try {
		const lastPackKey = (await store.get('lastPackKey')) || undefined;
		const list = (await store.get('packList')) || [];
		const out: string[] = [];
		let inserted = false;
		if (lastPackKey) {
			for (const element of list) {
				out.push(element);
				if (!inserted && element === lastPackKey) {
					out.push(packKey);
					inserted = true;
				}
			}
			if (!inserted) out.unshift(packKey);
		} else {
			out.unshift(packKey);
		}
		await store.put('packList', out);
	} catch (error) {
		log.warn('build:store-packlist-failed', { packKey, error: String(error) });
	}

	const builtSet = new Set(batch.map((x) => x.toLowerCase()));
	const basesToDelete = needBases.filter((x) => builtSet.has(x.toLowerCase()));
	const looseToDelete = needLoose.filter((x) => builtSet.has(x.toLowerCase()));

	await deleteHydrPendingOids(database, work.workId, 'base', basesToDelete);
	await deleteHydrPendingOids(database, work.workId, 'loose', looseToDelete);

	updateProgress(work, {
		segmentSeq: seq,
		producedBytes: (work.progress?.producedBytes || 0) + packfile.byteLength,
	});

	const counts = await getHydrPendingCounts(database, work.workId);
	const remaining = counts.bases + counts.loose;
	log.info('build:segment-done', { packKey, built: objs.length, remaining });
	return remaining > 0 ? 'more' : 'done';
}
