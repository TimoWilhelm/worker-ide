import { asTypedStorage } from '../repo-state';

import type { RepoStateSchema, HydrationWork } from '../repo-state';
import type { Logger } from '@git/common/logger';

export type HydrationCtx = {
	state: DurableObjectState;
	env: GitWorkerEnvironment;
	prefix: string;
	store: ReturnType<typeof asTypedStorage<RepoStateSchema>>;
	cfg: {
		unpackMaxMs: number;
		unpackDelayMs: number;
		unpackBackoffMs: number;
		chunk: number;
		keepPacks: number;
		windowMax: number;
	};
	log: Logger;
};

export type HydrationPlan = {
	snapshot: { lastPackKey: string | null; packListCount: number };
	window: { packKeys: string[] };
	counts: {
		deltaBases: number;
		looseOnly: number;
		totalCandidates: number;
		alreadyCovered: number;
		toPack: number;
	};
	segments: { estimated: number; maxObjectsPerSegment: number; maxBytesPerSegment: number };
	budgets: { timePerSliceMs: number; softSubrequestLimit: number };
	stats: { examinedPacks: number; examinedObjects: number; examinedLoose: number };
	warnings: string[];
	partial: boolean;
};

export type StageHandlerResult = {
	continue: boolean;
	persist?: boolean;
};

export type StageHandler = (context: HydrationCtx, work: HydrationWork) => Promise<StageHandlerResult>;

export type PackHeaderEx = { type: number; baseRel?: number; baseOid?: string };
