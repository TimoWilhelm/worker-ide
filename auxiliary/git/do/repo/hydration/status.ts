import { createLogger } from '@git/common/index';
import { loadIdxParsed } from '@git/git/pack/idx-cache';
import { readPackHeaderEx } from '@git/git/pack/index';
import { packIndexKey } from '@git/keys';

import {
	HYDR_SAMPLE_PER_PACK,
	HYDR_MAX_OBJS_PER_SEGMENT,
	HYDR_SEG_MAX_BYTES,
	HYDR_SOFT_SUBREQ_LIMIT,
	PACK_TYPE_OFS_DELTA,
	PACK_TYPE_REF_DELTA,
	getHydrConfig,
	makeHydrationLogger,
	buildRecentWindowKeys,
	buildHydrationCoverageSet,
	buildPhysicalIndex,
} from './helpers';
import { getDb as getDatabase, deletePackObjects, normalizePackKey } from '../db/index';
import { asTypedStorage } from '../repo-state';

import type { RepoStateSchema } from '../repo-state';
import type { HydrationPlan } from './types';

export async function summarizeHydrationPlan(
	state: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
): Promise<HydrationPlan> {
	const log = makeHydrationLogger(environment, prefix);
	const store = asTypedStorage<RepoStateSchema>(state.storage);
	const cfg = getHydrConfig(environment);

	const lastPackKey = (await store.get('lastPackKey')) || null;
	const packListRaw = (await store.get('packList')) || [];
	const packList = Array.isArray(packListRaw) ? packListRaw : [];

	const window = buildRecentWindowKeys(lastPackKey, packList, cfg.windowMax);

	const covered = await buildHydrationCoverageSet(state, store, cfg);

	let examinedObjects = 0;
	const baseCandidates = new Set<string>();
	try {
		const SAMPLE_PER_PACK = HYDR_SAMPLE_PER_PACK;
		for (const key of window) {
			const parsed = await loadIdxParsed(environment, key);
			if (!parsed) continue;
			const phys = buildPhysicalIndex(parsed);
			const stride = Math.max(1, Math.floor(phys.sorted.length / SAMPLE_PER_PACK));
			let count = 0;
			for (let index = 0; index < phys.sorted.length && count < SAMPLE_PER_PACK; index += stride) {
				const off = phys.sorted[index];
				const header = await readPackHeaderEx(environment, key, off);
				if (!header) continue;
				examinedObjects++;
				let baseOid: string | undefined;
				if (header.type === PACK_TYPE_OFS_DELTA) {
					const baseOff = off - (header.baseRel || 0);
					const baseIndex = phys.offToIdx.get(baseOff);
					if (baseIndex !== undefined) baseOid = phys.oids[baseIndex];
				} else if (header.type === PACK_TYPE_REF_DELTA) {
					baseOid = header.baseOid;
				}
				if (baseOid) {
					const q = baseOid.toLowerCase();
					if (!phys.oidsSet.has(q) || !covered.has(q)) {
						baseCandidates.add(q);
					}
				}
				count++;
			}
		}
	} catch {}

	let examinedLoose = 0;
	let looseOnly = 0;
	try {
		const it = await state.storage.list({ prefix: 'obj:', limit: 500 });
		for (const k of it.keys()) {
			const oid = String(k).slice(4).toLowerCase();
			examinedLoose++;
			if (!covered.has(oid)) looseOnly++;
		}
	} catch {}

	const estimatedDeltaBases = baseCandidates.size;
	const counts = {
		deltaBases: estimatedDeltaBases,
		looseOnly,
		totalCandidates: looseOnly + estimatedDeltaBases,
		alreadyCovered: 0,
		toPack: looseOnly + estimatedDeltaBases,
	};

	const segments = {
		estimated: Math.max(0, Math.ceil(counts.toPack / HYDR_MAX_OBJS_PER_SEGMENT)),
		maxObjectsPerSegment: HYDR_MAX_OBJS_PER_SEGMENT,
		maxBytesPerSegment: HYDR_SEG_MAX_BYTES,
	};

	const out: HydrationPlan = {
		snapshot: { lastPackKey, packListCount: packListRaw.length || 0 },
		window: { packKeys: window },
		counts,
		segments,
		budgets: { timePerSliceMs: cfg.unpackMaxMs, softSubrequestLimit: HYDR_SOFT_SUBREQ_LIMIT },
		stats: { examinedPacks: window.length, examinedObjects, examinedLoose },
		warnings: ['summary-partial-simple', 'summary-sampled-deltas'],
		partial: true,
	};
	log.debug('dryRun:summary', out);
	return out;
}

export async function clearHydrationState(
	state: DurableObjectState,
	environment: GitWorkerEnvironment,
): Promise<{ clearedWork: boolean; clearedQueue: number; removedPacks: number }> {
	const store = asTypedStorage<RepoStateSchema>(state.storage);
	const log = createLogger(environment.LOG_LEVEL, { service: 'Hydration', doId: state.id.toString() });
	const database = getDatabase(state.storage);
	let clearedWork = false;
	let clearedQueue = 0;
	let removedPacks = 0;

	const work = await store.get('hydrationWork');
	if (work) {
		await store.delete('hydrationWork');
		clearedWork = true;
	}
	const queue = (await store.get('hydrationQueue')) || [];
	clearedQueue = Array.isArray(queue) ? queue.length : 0;
	await store.put('hydrationQueue', []);

	const list = (await store.get('packList')) || [];
	const toRemove: string[] = [];
	for (const key of list) {
		const base = normalizePackKey(key);
		if (base.startsWith('pack-hydr-')) toRemove.push(key);
	}

	for (const key of toRemove) {
		try {
			await environment.REPO_BUCKET.delete(key);
		} catch (error) {
			log.warn('clear:delete-pack-failed', { key, error: String(error) });
		}
		try {
			await environment.REPO_BUCKET.delete(packIndexKey(key));
		} catch (error) {
			log.warn('clear:delete-pack-index-failed', { key, error: String(error) });
		}
		try {
			await deletePackObjects(database, key);
		} catch (error) {
			log.warn('clear:delete-packObjects-failed', { key, error: String(error) });
		}
		removedPacks++;
	}

	if (toRemove.length > 0) {
		const keep = list.filter((k) => !toRemove.includes(k));
		try {
			await store.put('packList', keep);
		} catch (error) {
			log.warn('clear:put-packlist-failed', { error: String(error) });
		}
		try {
			const last = await store.get('lastPackKey');
			if (last && toRemove.includes(String(last))) {
				await store.delete('lastPackKey');
				await store.delete('lastPackOids');
			}
		} catch (error) {
			log.warn('clear:put-lastpack-failed', { error: String(error) });
		}
	}

	return { clearedWork, clearedQueue, removedPacks };
}
