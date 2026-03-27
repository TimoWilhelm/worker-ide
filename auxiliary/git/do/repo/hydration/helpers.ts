import { createLogger } from '@git/common/index';
import { getDoIdFromPath } from '@git/keys';

import { getDb as getDatabase, hasHydrCoverForWork, insertHydrCoverOids, getPackOids, normalizePackKey } from '../db/index';
import { parseEpochFromHydrPackKey, calculateStableEpochs } from '../packs';
import { getConfig } from '../repo-config';
import { asTypedStorage } from '../repo-state';

import type { RepoStateSchema, HydrationWork, HydrationStage } from '../repo-state';
import type { Logger } from '@git/common/logger';

export const HYDR_SAMPLE_PER_PACK = 128;
export const HYDR_SOFT_SUBREQ_LIMIT = 800;
export const HYDR_LOOSE_LIST_PAGE = 250;
export const HYDR_SEG_MAX_BYTES = 8 * 1024 * 1024;
export const HYDR_MAX_OBJS_PER_SEGMENT = 2000;
export const HYDR_EST_COMPRESSION_RATIO = 0.6;
export const PACK_TYPE_OFS_DELTA = 6 as const;
export const PACK_TYPE_REF_DELTA = 7 as const;

export function nowMs() {
	return Date.now();
}

export function getHydrConfig(environment: GitWorkerEnvironment) {
	const base = getConfig(environment);
	const windowMax = base.packListMax;
	return {
		unpackMaxMs: base.unpackMaxMs,
		unpackDelayMs: base.unpackDelayMs,
		unpackBackoffMs: base.unpackBackoffMs,
		chunk: base.unpackChunkSize,
		keepPacks: base.keepPacks,
		windowMax,
	};
}

export function makeHydrationLogger(environment: GitWorkerEnvironment, lastPackKey?: string | null): Logger {
	const doId = getDoIdFromPath(lastPackKey || '') || undefined;
	return createLogger(environment.LOG_LEVEL, { service: 'Hydration', doId });
}

export function buildRecentWindowKeys(lastPackKey: string | null, packList: string[], windowMax: number): string[] {
	const windowKeys: string[] = [];
	if (lastPackKey) windowKeys.push(lastPackKey);
	for (const k of packList) if (!windowKeys.includes(k)) windowKeys.push(k);
	return windowKeys.slice(0, windowMax);
}

async function computeStableHydrationWindow(
	store: ReturnType<typeof asTypedStorage<RepoStateSchema>>,
	cfg: ReturnType<typeof getHydrConfig>,
): Promise<{ window: string[]; lastPackKey: string | null }> {
	const lastPackKey = (await store.get('lastPackKey')) || null;
	const packListRaw = (await store.get('packList')) || [];
	const packList = Array.isArray(packListRaw) ? packListRaw : [];

	const { stableEpochs } = calculateStableEpochs(packList, cfg.keepPacks, lastPackKey || undefined);
	const stableSet = new Set(stableEpochs);

	const hydra: string[] = [];
	for (const k of packList) {
		const e = parseEpochFromHydrPackKey(k);
		if (e && stableSet.has(e)) hydra.push(k);
	}

	const lbase = normalizePackKey(lastPackKey || '');
	const lastEpoch = lastPackKey ? parseEpochFromHydrPackKey(lastPackKey) : null;
	if (lastPackKey && lbase.startsWith('pack-hydr-') && lastEpoch && stableSet.has(lastEpoch)) {
		hydra.unshift(lastPackKey);
	}

	const window = hydra.slice(0, cfg.windowMax);
	return { window, lastPackKey };
}

export async function ensureHydrCoverForWork(
	state: DurableObjectState,
	store: ReturnType<typeof asTypedStorage<RepoStateSchema>>,
	cfg: ReturnType<typeof getHydrConfig>,
	workId: string,
): Promise<void> {
	if (!workId) return;
	const database = getDatabase(state.storage);
	try {
		const exists = await hasHydrCoverForWork(database, workId);
		if (exists) return;
	} catch {}

	const { window, lastPackKey } = await computeStableHydrationWindow(store, cfg);

	for (const pk of window) {
		try {
			const oids = (await getPackOids(database, pk)).map((o) => o.toLowerCase());
			await insertHydrCoverOids(database, workId, oids);
		} catch {}
	}

	const includeLastOids = !!lastPackKey && normalizePackKey(lastPackKey).startsWith('pack-hydr-') && window.includes(lastPackKey);
	if (includeLastOids) {
		try {
			const last = ((await store.get('lastPackOids')) || []).slice(0, 10_000);
			const oids = (Array.isArray(last) ? last : []).map((oid: string) => oid.toLowerCase());
			await insertHydrCoverOids(database, workId, oids);
		} catch {}
	}
}

export async function buildHydrationCoverageSet(
	state: DurableObjectState,
	store: ReturnType<typeof asTypedStorage<RepoStateSchema>>,
	cfg: ReturnType<typeof getHydrConfig>,
): Promise<Set<string>> {
	const covered = new Set<string>();
	try {
		const database = getDatabase(state.storage);
		const { window, lastPackKey } = await computeStableHydrationWindow(store, cfg);
		try {
			if (window.length > 0) {
				for (const pk of window) {
					const rows = await getPackOids(database, pk);
					for (const oid of rows) covered.add(String(oid).toLowerCase());
				}
			}
		} catch {}
		const includeLastOids = !!lastPackKey && normalizePackKey(lastPackKey).startsWith('pack-hydr-') && window.includes(lastPackKey);
		if (includeLastOids) {
			const last = (await store.get('lastPackOids')) || [];
			for (const x of last.slice(0, 10_000)) covered.add(x.toLowerCase());
		}
	} catch {}
	return covered;
}

export function setStage(work: HydrationWork, stage: HydrationStage, log: Logger) {
	if (work.stage !== stage) {
		log.debug('hydration:transition', { from: work.stage, to: stage });
		work.stage = stage;
	}
}

export type HydrationProgress = NonNullable<HydrationWork['progress']>;

export function updateProgress(work: HydrationWork, patch: Partial<HydrationProgress>) {
	const base: HydrationProgress = { ...work.progress, ...patch };
	work.progress = base;
}

export function clearError(work: HydrationWork) {
	if (work.error) work.error = undefined;
}

export function buildPhysicalIndex(parsed: { oids: string[]; offsets: number[] }) {
	const { oids, offsets } = parsed;
	const oidsSet = new Set(oids.map((x) => x.toLowerCase()));
	const sorted = [...offsets].sort((a, b) => a - b);
	const offToIndex = new Map<number, number>();
	for (let index = 0; index < offsets.length; index++) offToIndex.set(offsets[index], index);
	return { oids, offsets, oidsSet, sorted, offToIdx: offToIndex };
}
