import type { CacheContext } from '@git/cache/index';

// Global caps
const MAX_SIMULTANEOUS_CONNECTIONS = 6; // Cloudflare per-request connection limit
export const DEFAULT_SUBREQUEST_BUDGET = 900; // soft budget before hard cap (~1000)

// Structural limiter type compatible with RequestMemo.limiter
export type Limiter = { run<T>(label: string, function_: () => Promise<T>): Promise<T> };

// Lightweight semaphore to cap concurrent upstream calls per request
class SubrequestLimiter {
	private max: number;
	private cur = 0;
	private queue: Array<() => void> = [];

	constructor(max: number) {
		this.max = Math.max(1, max | 0);
	}

	private acquire(): Promise<void> {
		if (this.cur < this.max) {
			this.cur++;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.queue.push(() => {
				this.cur++;
				resolve();
			});
		});
	}

	private release() {
		this.cur--;
		if (this.cur < 0) this.cur = 0;
		const next = this.queue.shift();
		if (next) next();
	}

	async run<T>(_label: string, function_: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await function_();
		} finally {
			this.release();
		}
	}
}

export function getLimiter(cacheContext?: CacheContext): Limiter {
	const fallback: Limiter = new SubrequestLimiter(MAX_SIMULTANEOUS_CONNECTIONS);
	if (!cacheContext) return fallback as Limiter;
	cacheContext.memo = cacheContext.memo || {};
	if (!cacheContext.memo.limiter) {
		cacheContext.memo.limiter = new SubrequestLimiter(MAX_SIMULTANEOUS_CONNECTIONS);
	}
	return cacheContext.memo.limiter as Limiter;
}

// Decrement subrequest soft budget; returns false when budget exhausted
export function countSubrequest(cacheContext?: CacheContext, n = 1): boolean {
	if (!cacheContext) return true; // nothing to track
	cacheContext.memo = cacheContext.memo || {};
	const current = cacheContext.memo.subreqBudget ?? DEFAULT_SUBREQUEST_BUDGET;
	const next = current - Math.max(1, n);
	cacheContext.memo.subreqBudget = next;
	return next >= 0;
}
