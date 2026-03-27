import type { CacheContext } from '@git/cache/index';

export type AssemblerPlan =
	| {
			type: 'InitCloneUnion';
			repoId: string;
			packKeys: string[];
			needed: string[];
			wants: string[];
			ackOids: string[];
			signal?: AbortSignal;
			cacheCtx?: CacheContext;
	  }
	| {
			type: 'IncrementalSingle';
			repoId: string;
			packKey: string;
			needed: string[];
			ackOids: string[];
			signal?: AbortSignal;
			cacheCtx?: CacheContext;
	  }
	| {
			type: 'IncrementalMulti';
			repoId: string;
			packKeys: string[];
			needed: string[];
			ackOids: string[];
			signal?: AbortSignal;
			cacheCtx?: CacheContext;
	  }
	| {
			type: 'RepositoryNotReady';
	  };

export type ResolvedAssemblerPlan = Exclude<AssemblerPlan, { type: 'RepositoryNotReady' }>;
