/**
 * Generic async retry utility with exponential backoff and jitter.
 *
 * Works in both browser and worker environments (uses setTimeout,
 * not scheduler.wait). For Durable Object RPC retries, use the
 * specialised `do-retry-proxy` in `worker/lib/` instead.
 */

export interface RetryOptions {
	/** Maximum number of attempts including the first call (default: 3) */
	maxAttempts?: number;
	/** Base delay in milliseconds for exponential backoff (default: 200) */
	baseDelayMs?: number;
	/** Maximum delay cap in milliseconds (default: 2000) */
	maxDelayMs?: number;
	/** Optional predicate — return false to bail out early without retrying */
	shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const DEFAULTS = {
	maxAttempts: 3,
	baseDelayMs: 200,
	maxDelayMs: 2000,
} as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Retry an async operation with jittered exponential backoff.
 *
 * @example
 * ```ts
 * await retry(() => abortAgent(projectId, sessionId));
 * await retry(() => fetch('/api/health'), { maxAttempts: 5 });
 * ```
 */
export async function retry<T>(function_: () => Promise<T>, options?: RetryOptions): Promise<T> {
	const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULTS.maxAttempts);
	const baseDelayMs = options?.baseDelayMs ?? DEFAULTS.baseDelayMs;
	const maxDelayMs = options?.maxDelayMs ?? DEFAULTS.maxDelayMs;

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await function_();
		} catch (error) {
			lastError = error;

			if (attempt >= maxAttempts) break;
			if (options?.shouldRetry && !options.shouldRetry(error, attempt)) break;

			// Full-jitter exponential backoff
			const upperBound = Math.min(2 ** (attempt - 1) * baseDelayMs, maxDelayMs);
			await sleep(Math.floor(Math.random() * upperBound));
		}
	}

	throw lastError;
}
