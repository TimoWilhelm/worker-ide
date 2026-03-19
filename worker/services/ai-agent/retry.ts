/**
 * Retry logic for AI agent API calls.
 * Exponential backoff with retryable error classification.
 */

import { parseApiError } from './utilities';

// =============================================================================
// Constants
// =============================================================================

/** Base delay for first retry (ms) */
const RETRY_INITIAL_DELAY = 2000;

/** Exponential multiplier */
const RETRY_BACKOFF_FACTOR = 2;

/** Cap when no retry-after headers present (ms) */
const RETRY_MAX_DELAY_NO_HEADERS = 30_000;

/** Maximum safe timeout value to prevent overflow */
const RETRY_MAX_DELAY = 2_147_483_647;

// =============================================================================
// Error Classification
// =============================================================================

/** Non-retryable error codes from parseApiError */
const NON_RETRYABLE_CODES = new Set(['AUTH_ERROR', 'INVALID_REQUEST', 'ABORTED']);

/** Retryable error codes from parseApiError */
const RETRYABLE_CODES = new Set(['OVERLOADED', 'RATE_LIMIT', 'SERVER_ERROR']);

/**
 * Network/system error codes that indicate a transient connection failure.
 * These are always retryable regardless of HTTP status.
 */
const RETRYABLE_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPROTO']);

/** Maximum depth to walk the error `.cause` chain when looking for network codes */
const MAX_CAUSE_DEPTH = 5;

/**
 * Extract the `code` property from an error-like value, if present.
 */
function getErrorCode(error: unknown): string | undefined {
	if (typeof error === 'object' && error !== undefined && error !== null && 'code' in error) {
		const { code } = error;
		return typeof code === 'string' ? code : undefined;
	}
	return undefined;
}

/**
 * Classify a connection/network error.
 *
 * Checks the error (and its `.cause` chain up to {@link MAX_CAUSE_DEPTH} levels)
 * for known network error codes, and falls back to pattern-matching the error
 * message for common network failure strings.
 *
 * Returns a human-readable reason if the error is a transient connection failure,
 * or `undefined` if it is not.
 */
export function classifyConnectionError(error: unknown): string | undefined {
	// Walk the error + its cause chain looking for a retryable network code
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth++) {
		const code = getErrorCode(current);
		if (code && RETRYABLE_NETWORK_CODES.has(code)) {
			return code === 'ETIMEDOUT' ? 'Network timeout' : 'Connection error';
		}
		// Traverse .cause
		current = typeof current === 'object' && current !== null && 'cause' in current ? current.cause : undefined;
	}

	// Pattern-match on the top-level error message
	if (error instanceof Error) {
		const message = error.message;
		if (/\bfetch failed\b/i.test(message)) return 'Connection error';
		if (/\bsocket hang up\b/i.test(message)) return 'Connection error';
		if (/\bnetwork\b.*\berror\b/i.test(message)) return 'Connection error';
		if (/\bssl\b/i.test(message) && /\berror\b/i.test(message)) return 'Connection error';
	}

	return undefined;
}

/**
 * Determine if an error is retryable.
 * Returns a human-readable reason string if retryable, undefined if not.
 */
export function classifyRetryableError(error: unknown): string | undefined {
	// Abort errors are never retryable
	if (error instanceof Error && error.name === 'AbortError') {
		return undefined;
	}

	// Context overflow errors are never retryable
	if (error instanceof Error && /context.*(too long|overflow|exceed)/i.test(error.message)) {
		return undefined;
	}

	const parsed = parseApiError(error);

	// Check structured error codes
	if (parsed.code && NON_RETRYABLE_CODES.has(parsed.code)) {
		return undefined;
	}
	if (parsed.code && RETRYABLE_CODES.has(parsed.code)) {
		return parsed.message;
	}

	// Pattern-match on message for unclassified errors
	const message = parsed.message.toLowerCase();
	if (/overloaded/i.test(message) || /529/.test(message)) {
		return 'Provider is overloaded';
	}
	if (/rate.?limit/i.test(message) || /429/.test(message) || /too many requests/i.test(message)) {
		return 'Rate limited';
	}
	if (/exhausted|unavailable/i.test(message)) {
		return 'Provider is unavailable';
	}

	// Check for transient connection/network errors
	const connectionReason = classifyConnectionError(error);
	if (connectionReason) {
		return connectionReason;
	}

	return undefined;
}

// =============================================================================
// Delay Calculation
// =============================================================================

/**
 * Extract retry-after delay from an error's response headers.
 * Returns undefined if no usable headers found.
 */
function getRetryAfterFromError(error: unknown): number | undefined {
	// Try to extract response from error
	if (typeof error !== 'object' || error === undefined || error === null) {
		return undefined;
	}

	const response = 'response' in error && error.response instanceof Response ? error.response : undefined;
	if (!response) return undefined;

	// Try retry-after-ms header first
	const retryAfterMs = response.headers.get('retry-after-ms');
	if (retryAfterMs) {
		const ms = Number.parseFloat(retryAfterMs);
		if (!Number.isNaN(ms) && ms > 0) {
			return ms;
		}
	}

	// Try retry-after header (seconds or HTTP date)
	const retryAfter = response.headers.get('retry-after');
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		if (!Number.isNaN(seconds)) {
			return Math.ceil(seconds * 1000);
		}
		// Try parsing as HTTP date
		const date = Date.parse(retryAfter);
		if (!Number.isNaN(date)) {
			const delay = date - Date.now();
			if (delay > 0) return delay;
		}
	}

	return undefined;
}

/**
 * Calculate the delay before the next retry attempt.
 *
 * Priority:
 * 1. retry-after-ms header
 * 2. retry-after header (seconds or HTTP date)
 * 3. Exponential backoff: min(initialDelay * factor^(attempt-1), maxDelay)
 */
export function calculateRetryDelay(attempt: number, error?: unknown): number {
	const headerDelay = error ? getRetryAfterFromError(error) : undefined;
	if (headerDelay !== undefined) {
		return Math.min(headerDelay, RETRY_MAX_DELAY);
	}

	const exponentialDelay = RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR ** (attempt - 1);
	return Math.min(exponentialDelay, RETRY_MAX_DELAY_NO_HEADERS);
}

// =============================================================================
// Sleep with Abort Support
// =============================================================================

/**
 * Sleep for the given duration, respecting an AbortSignal.
 */
export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	const clamped = Math.min(milliseconds, RETRY_MAX_DELAY);

	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException('Aborted', 'AbortError'));
			return;
		}

		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, clamped);

		function onAbort() {
			clearTimeout(timer);
			reject(new DOMException('Aborted', 'AbortError'));
		}

		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
