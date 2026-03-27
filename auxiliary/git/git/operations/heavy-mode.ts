import type { CacheContext } from '@git/cache/index';

/**
 * Enter the closure phase for upload-pack where we want to avoid excessive Cache API reads
 * and cap DO-backed loose loader calls. This sets flags and shared budgets in memo.
 */
export function beginClosurePhase(cacheContext?: CacheContext, options?: { loaderCap?: number; doBatchBudget?: number }) {
	if (!cacheContext) return;
	cacheContext.memo = cacheContext.memo || {};
	cacheContext.memo.flags = cacheContext.memo.flags || new Set<string>();
	cacheContext.memo.flags.add('no-cache-read');
	cacheContext.memo.loaderCalls = 0;
	if (typeof options?.loaderCap === 'number') {
		cacheContext.memo.loaderCap = options.loaderCap;
	} else if (typeof cacheContext.memo.loaderCap !== 'number') {
		cacheContext.memo.loaderCap = 400; // conservative default during closure
	}
	// Initialize shared DO batch budget if not already set
	if (typeof cacheContext.memo.doBatchBudget !== 'number') {
		cacheContext.memo.doBatchBudget = typeof options?.doBatchBudget === 'number' ? options.doBatchBudget : 20;
	}
}

/**
 * Exit the closure phase and transition to downstream reads (single-pack/multi-pack/loose).
 * Resets loader counters and adjusts loader cap depending on whether closure timed out.
 */
export function endClosurePhase(cacheContext?: CacheContext) {
	if (!cacheContext?.memo) return;
	cacheContext.memo.loaderCalls = 0;
	cacheContext.memo.flags?.delete('loader-capped');
	const timedOut = cacheContext.memo.flags?.has('closure-timeout') === true;
	cacheContext.memo.loaderCap = timedOut ? 250 : 600;
}
