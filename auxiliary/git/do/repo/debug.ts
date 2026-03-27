/**
 * Debug utilities for repository inspection
 *
 * This module provides debug methods to inspect repository state,
 * check object presence, and verify pack membership.
 */

import { isValidOid } from '@git/common/index';
import { r2LooseKey, doPrefix, packIndexKey } from '@git/keys';

import { findPacksContainingOid, getDb as getDatabase, getHydrPendingCounts, getHydrPendingOids } from './db/index';
import { asTypedStorage, objKey as objectKey } from './repo-state';
import { readCommitFromStore } from './storage';

import type { RepoStateSchema, Head, UnpackWork, HydrationWork, HydrationTask } from './repo-state';

/**
 * Small helper to run an async map with a concurrency limit.
 */
async function mapLimit<T, R>(items: T[], limit: number, function_: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const returnValue: R[] = Array.from({ length: items.length });
	let next = 0;
	async function worker() {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			returnValue[index] = await function_(items[index], index);
		}
	}
	const n = Math.max(1, Math.min(limit | 0, items.length));
	await Promise.all(new Array(n).fill(0).map(() => worker()));
	return returnValue;
}

/**
 * Get comprehensive debug state of the repository
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @returns Debug state object with repository metadata and statistics
 */
export async function debugState(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
): Promise<{
	meta: { doId: string; prefix: string };
	head?: Head;
	refsCount: number;
	refs: { name: string; oid: string }[];
	lastPackKey: string | null;
	lastPackOidsCount: number;
	packListCount: number;
	packList: string[];
	packStats?: Array<{
		key: string;
		packSize?: number;
		hasIndex: boolean;
		indexSize?: number;
	}>;
	unpackWork: {
		packKey: string;
		totalCount: number;
		processedCount: number;
		startedAt: number;
	} | null;
	unpackNext: string | null;
	looseSample: string[];
	hydrationPackCount: number;
	// Last maintenance timestamp (ms since epoch) to help compute next maintenance window in UI
	lastMaintenanceMs?: number;
	// SQLite database size in bytes (includes both SQL tables and KV for SQLite-backed DOs)
	dbSizeBytes?: number;
	// Quick sample of R2 loose mirror usage (first page only)
	looseR2SampleBytes?: number;
	looseR2SampleCount?: number;
	looseR2Truncated?: boolean;
	hydration?: {
		running: boolean;
		stage?: string;
		segmentSeq?: number;
		queued: number;
		needBasesCount?: number;
		needLooseCount?: number;
		packIndex?: number;
		objCursor?: number;
		workId?: string;
		startedAt?: number;
		producedBytes?: number;
		windowCount?: number;
		window?: string[];
		needBasesSample?: string[];
		needLooseSample?: string[];
		error?: {
			message?: string;
			fatal?: boolean;
			retryCount?: number;
			firstErrorAt?: number;
		};
		queueReasons?: ('post-unpack' | 'post-maint' | 'admin')[];
	};
}> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	const references = (await store.get('refs')) ?? [];
	const head = await store.get('head');
	const lastPackKey = await store.get('lastPackKey');
	const lastPackOids = (await store.get('lastPackOids')) ?? [];
	const packList = (await store.get('packList')) ?? [];
	const unpackWork = await store.get('unpackWork');
	const unpackNext = await store.get('unpackNext');
	const lastMaintenanceMs = await store.get('lastMaintenanceMs');
	const hydrationWork = (await store.get('hydrationWork')) as HydrationWork | undefined;
	const hydrationQueue = ((await store.get('hydrationQueue')) as HydrationTask[] | undefined) || [];

	// Helpers
	const looseSample = await listLooseSample(context);
	const {
		bases: basesPending,
		loose: loosePending,
		baseSample: hydrBaseSample,
		looseSample: hydrLooseSample,
	} = await getHydrationPending(context, hydrationWork?.workId);
	const packStats = await getPackStatsLimited(environment, packList, 20, 6);
	const hydrationPackCount = countHydrationPacks(packList);
	const prefix = doPrefix(context.id.toString());
	const databaseSizeBytes = getDatabaseSize(context);
	const { bytes: looseR2SampleBytes, count: looseR2SampleCount, truncated: looseR2Truncated } = await sampleR2Loose(prefix, environment);
	const sanitizedUnpackWork = sanitizeUnpackWork(unpackWork as UnpackWork | null);

	return {
		meta: { doId: context.id.toString(), prefix },
		head,
		refsCount: references.length,
		refs: references.slice(0, 20),
		lastPackKey: lastPackKey || null,
		lastPackOidsCount: lastPackOids.length,
		packListCount: packList.length,
		packList,
		packStats: packStats.length > 0 ? packStats : undefined,
		unpackWork: sanitizedUnpackWork,
		unpackNext: unpackNext || null,
		looseSample,
		hydrationPackCount,
		lastMaintenanceMs,
		dbSizeBytes: databaseSizeBytes,
		looseR2SampleBytes,
		looseR2SampleCount,
		looseR2Truncated,
		hydration: {
			running: !!hydrationWork,
			stage: hydrationWork?.stage,
			segmentSeq: hydrationWork?.progress?.segmentSeq,
			queued: Array.isArray(hydrationQueue) ? hydrationQueue.length : 0,
			needBasesCount: basesPending > 0 ? basesPending : undefined,
			needLooseCount: loosePending > 0 ? loosePending : undefined,
			packIndex: hydrationWork?.progress?.packIndex,
			objCursor: hydrationWork?.progress?.objCursor,
			workId: hydrationWork?.workId,
			startedAt: hydrationWork?.startedAt,
			producedBytes: hydrationWork?.progress?.producedBytes,
			windowCount: Array.isArray(hydrationWork?.snapshot?.window) ? hydrationWork.snapshot.window.length : undefined,
			window: Array.isArray(hydrationWork?.snapshot?.window) ? hydrationWork.snapshot.window.slice(0, 6) : undefined,
			needBasesSample: hydrBaseSample.length > 0 ? hydrBaseSample : undefined,
			needLooseSample: hydrLooseSample.length > 0 ? hydrLooseSample : undefined,
			error: hydrationWork?.error
				? {
						message: hydrationWork.error.message,
						fatal: hydrationWork.error.fatal,
						retryCount: hydrationWork.error.retryCount,
						firstErrorAt: hydrationWork.error.firstErrorAt,
					}
				: undefined,
			queueReasons: Array.isArray(hydrationQueue) ? hydrationQueue.map((q) => q.reason) : [],
		},
	};
}

/**
 * Debug check for a commit and its tree
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @param commit - Commit OID to check
 * @returns Detailed commit information and presence in storage
 */
export async function debugCheckCommit(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	commit: string,
): Promise<{
	commit: { oid: string; parents: string[]; tree?: string };
	presence: { hasLooseCommit: boolean; hasLooseTree: boolean; hasR2LooseTree: boolean };
	membership: Record<string, { hasCommit: boolean; hasTree: boolean }>;
}> {
	const q = (commit || '').toLowerCase();
	if (!isValidOid(q)) {
		throw new Error('Invalid commit');
	}

	const store = asTypedStorage<RepoStateSchema>(context.storage);
	const database = getDatabase(context.storage);
	const packList = (await store.get('packList')) ?? [];
	const membership: Record<string, { hasCommit: boolean; hasTree: boolean }> = {};

	// Check which packs contain the commit - query by OID directly
	try {
		const commitPacks = await findPacksContainingOid(database, q);
		const commitPackSet = new Set(commitPacks);
		for (const key of packList) {
			membership[key] = { hasCommit: commitPackSet.has(key), hasTree: false };
		}
	} catch {}
	// Initialize all packs as not having the commit if query fails
	if (Object.keys(membership).length === 0) {
		for (const key of packList) {
			membership[key] = { hasCommit: false, hasTree: false };
		}
	}

	const prefix = doPrefix(context.id.toString());
	let tree: string | undefined = undefined;
	let parents: string[] = [];

	try {
		const info = await readCommitFromStore(context, environment, prefix, q);
		if (info) {
			tree = info.tree.toLowerCase();
			parents = info.parents;
		}
	} catch {}

	const hasLooseCommit = !!(await context.storage.get(objectKey(q)));
	let hasLooseTree = false;
	let hasR2LooseTree = false;

	if (tree) {
		hasLooseTree = !!(await context.storage.get(objectKey(tree)));
		try {
			const head = await environment.REPO_BUCKET.head(r2LooseKey(prefix, tree));
			hasR2LooseTree = !!head;
		} catch {}

		// Check which packs contain the tree - query by OID directly
		try {
			const treePacks = await findPacksContainingOid(database, tree);
			const treePackSet = new Set(treePacks);
			for (const key of Object.keys(membership)) {
				membership[key].hasTree = treePackSet.has(key);
			}
		} catch {}
	}

	return {
		commit: { oid: q, parents, tree },
		presence: { hasLooseCommit, hasLooseTree, hasR2LooseTree },
		membership,
	};
}

/**
 * Debug: Check if an OID exists in various storage locations
 * @param ctx - Durable Object state context
 * @param env - Worker environment
 * @param oid - The object ID to check
 * @returns Object presence information
 */
export async function debugCheckOid(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	oid: string,
): Promise<{
	oid: string;
	presence: {
		hasLoose: boolean;
		hasR2Loose: boolean;
	};
	inPacks: string[];
}> {
	if (!isValidOid(oid)) {
		throw new Error(`Invalid OID: ${oid}`);
	}

	const prefix = doPrefix(context.id.toString());

	// Check DO loose storage
	const hasLoose = !!(await context.storage.get(objectKey(oid)));

	// Check R2 loose storage
	let hasR2Loose = false;
	try {
		const head = await environment.REPO_BUCKET.head(r2LooseKey(prefix, oid));
		hasR2Loose = !!head;
	} catch {}

	// Check which packs contain this OID
	let inPacks: string[] = [];

	// Check which packs contain this OID - query by OID directly
	const database = getDatabase(context.storage);
	try {
		inPacks = await findPacksContainingOid(database, oid);
	} catch {}

	return {
		oid,
		presence: {
			hasLoose,
			hasR2Loose,
		},
		inPacks,
	};
}

/**
 * Helpers
 */

async function listLooseSample(context: DurableObjectState): Promise<string[]> {
	const out: string[] = [];
	try {
		const it = await context.storage.list({ prefix: 'obj:', limit: 10 });
		for (const k of it.keys()) out.push(String(k).slice(4));
	} catch {}
	return out;
}

async function getHydrationPending(
	context: DurableObjectState,
	workId?: string,
): Promise<{
	bases: number;
	loose: number;
	baseSample: string[];
	looseSample: string[];
}> {
	if (!workId) return { bases: 0, loose: 0, baseSample: [], looseSample: [] };
	try {
		const database = getDatabase(context.storage);
		const counts = await getHydrPendingCounts(database, workId);
		const baseSample = await getHydrPendingOids(database, workId, 'base', 10);
		const looseSample = await getHydrPendingOids(database, workId, 'loose', 10);
		return { bases: counts.bases, loose: counts.loose, baseSample, looseSample };
	} catch {
		return { bases: 0, loose: 0, baseSample: [], looseSample: [] };
	}
}

async function getPackStatsLimited(
	environment: GitWorkerEnvironment,
	packList: string[],
	limit: number,
	concurrency: number,
): Promise<
	Array<{
		key: string;
		packSize?: number;
		hasIndex: boolean;
		indexSize?: number;
	}>
> {
	const keys = packList.slice(0, Math.max(0, limit | 0));
	if (keys.length === 0) return [];
	try {
		const results = await mapLimit(
			keys,
			Math.max(1, concurrency | 0),
			async (
				packKey,
			): Promise<{
				key: string;
				packSize?: number;
				hasIndex: boolean;
				indexSize?: number;
			}> => {
				const stat: { key: string; packSize?: number; hasIndex: boolean; indexSize?: number } = {
					key: packKey,
					hasIndex: false,
				};
				try {
					const packHead = await environment.REPO_BUCKET.head(packKey);
					if (packHead) stat.packSize = packHead.size;
				} catch {}
				try {
					const indexHead = await environment.REPO_BUCKET.head(packIndexKey(packKey));
					if (indexHead) {
						stat.hasIndex = true;
						stat.indexSize = indexHead.size;
					}
				} catch {}
				return stat;
			},
		);
		return results;
	} catch {
		return [];
	}
}

function countHydrationPacks(packList: string[]): number {
	let n = 0;
	try {
		for (const k of packList) {
			const base = k.split('/').pop() || '';
			if (base.startsWith('pack-hydr-')) n++;
		}
	} catch {}
	return n;
}

function getDatabaseSize(context: DurableObjectState): number | undefined {
	try {
		const size = context.storage.sql.databaseSize;
		return typeof size === 'number' ? size : undefined;
	} catch {
		return undefined;
	}
}

async function sampleR2Loose(
	prefix: string,
	environment: GitWorkerEnvironment,
): Promise<{ bytes?: number; count?: number; truncated?: boolean }> {
	try {
		const prefixLoose = r2LooseKey(prefix, '');
		const list = await environment.REPO_BUCKET.list({ prefix: prefixLoose, limit: 250 });
		let sum = 0;
		for (const object of list.objects || []) sum += object.size || 0;
		return {
			bytes: sum,
			count: (list.objects || []).length,
			truncated: !!list.truncated,
		};
	} catch {
		return {};
	}
}

function sanitizeUnpackWork(unpackWork: UnpackWork | null): {
	packKey: string;
	totalCount: number;
	processedCount: number;
	startedAt: number;
} | null {
	if (!unpackWork) return null;
	return {
		packKey: unpackWork.packKey,
		totalCount: unpackWork.totalCount || 0,
		processedCount: unpackWork.processedCount,
		startedAt: unpackWork.startedAt,
	};
}
