interface RateLimitHeaders {
	'ratelimit-limit'?: string;
	'ratelimit-remaining'?: string;
	'ratelimit-reset'?: string;
	'retry-after'?: string;
}

/**
 * Accepted header input — either a plain object or a standard `Headers` instance
 * (e.g. from the Resend SDK).
 */
type HeadersInput = RateLimitHeaders | Headers;

interface RateLimitResponse {
	headers?: HeadersInput;
	is429?: boolean;
}

function getHeader(headers: HeadersInput, name: string): string | undefined {
	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing dynamic key on typed plain object
	return (headers as Record<string, string | undefined>)[name];
}

interface RateLimitState {
	maxConcurrent: number;
	remainingInWindow: number;
	resetSeconds: number;
}

export class RateLimiter {
	private maxConcurrent: number;
	private remainingInWindow: number;
	private resetSeconds: number;
	private readonly maxRetryDelay: number;

	/**
	 * @param initialLimit - Initial rate limit (default: 2)
	 * @param maxRetryDelay - Maximum retry delay in seconds (default: 60)
	 */
	constructor(initialLimit = 2, maxRetryDelay = 60) {
		this.maxConcurrent = initialLimit;
		this.remainingInWindow = Number.POSITIVE_INFINITY;
		this.resetSeconds = 1;
		this.maxRetryDelay = maxRetryDelay;
	}
	public getState(): RateLimitState {
		return {
			maxConcurrent: this.maxConcurrent,
			remainingInWindow: this.remainingInWindow,
			resetSeconds: this.resetSeconds,
		};
	}

	/**
	 * Calculate the optimal batch size based on:
	 * - Maximum concurrent requests
	 * - Remaining capacity in current window
	 * - Total items to process
	 */
	public calculateBatchSize(totalRemaining: number): number {
		return Math.min(this.maxConcurrent, Math.max(this.remainingInWindow, 0), totalRemaining);
	}
	public hasCapacity(): boolean {
		return this.remainingInWindow > 0 || this.remainingInWindow === Number.POSITIVE_INFINITY;
	}
	public getCapacityExhaustedDelay(): number {
		return Math.min(this.resetSeconds, this.maxRetryDelay);
	}

	/**
	 * Process response headers and update rate limit state
	 * @param response - Response with rate limit headers
	 * @returns true if this was a 429 rate limit response
	 */
	public processResponse(response: RateLimitResponse): boolean {
		const { headers, is429 = false } = response;

		if (!headers) {
			return is429;
		}

		// Update rate limit tracking from IETF standard headers
		const remaining = getHeader(headers, 'ratelimit-remaining');
		if (remaining) {
			this.remainingInWindow = Number.parseInt(remaining, 10);
		}

		const limit = getHeader(headers, 'ratelimit-limit');
		if (limit) {
			this.maxConcurrent = Number.parseInt(limit, 10);
		}

		const reset = getHeader(headers, 'ratelimit-reset');
		if (reset) {
			this.resetSeconds = Number.parseInt(reset, 10);
		}

		return is429;
	}

	/**
	 * Get retry delay for a 429 response
	 * Uses retry-after header if available, otherwise falls back to ratelimit-reset
	 */
	public get429RetryDelay(headers?: HeadersInput): number {
		if (headers) {
			const retryAfterValue = getHeader(headers, 'retry-after');
			if (retryAfterValue) {
				const retryAfter = Number.parseInt(retryAfterValue, 10);
				return Math.min(retryAfter, this.maxRetryDelay);
			}
		}
		return Math.min(this.resetSeconds, this.maxRetryDelay);
	}

	/**
	 * Decrement local capacity tracking after successful requests
	 * @param successCount - Number of successful requests made
	 */
	public decrementCapacity(successCount: number): void {
		if (this.remainingInWindow !== Number.POSITIVE_INFINITY) {
			this.remainingInWindow = Math.max(0, this.remainingInWindow - successCount);
		}
	}
	public getErrorRetryDelay(): number {
		return Math.min(this.resetSeconds, this.maxRetryDelay);
	}
}
