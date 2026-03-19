/**
 * Unit tests for the retry module.
 *
 * Tests error classification (retryable vs non-retryable), connection error
 * detection with cause chain traversal, retry delay calculation, and
 * abort-aware sleep.
 */

import { describe, expect, it, vi } from 'vitest';

import { classifyConnectionError, classifyRetryableError, calculateRetryDelay, sleep } from './retry';

// =============================================================================
// classifyConnectionError
// =============================================================================

describe('classifyConnectionError', () => {
	it('returns "Connection error" for ECONNRESET', () => {
		const error = new Error('read ECONNRESET');
		Object.assign(error, { code: 'ECONNRESET' });
		expect(classifyConnectionError(error)).toBe('Connection error');
	});

	it('returns "Network timeout" for ETIMEDOUT', () => {
		const error = new Error('connect ETIMEDOUT');
		Object.assign(error, { code: 'ETIMEDOUT' });
		expect(classifyConnectionError(error)).toBe('Network timeout');
	});

	it('returns "Connection error" for EPIPE', () => {
		const error = new Error('write EPIPE');
		Object.assign(error, { code: 'EPIPE' });
		expect(classifyConnectionError(error)).toBe('Connection error');
	});

	it('returns "Connection error" for ENOTFOUND', () => {
		const error = new Error('getaddrinfo ENOTFOUND api.example.com');
		Object.assign(error, { code: 'ENOTFOUND' });
		expect(classifyConnectionError(error)).toBe('Connection error');
	});

	it('returns "Connection error" for EAI_AGAIN', () => {
		const error = new Error('getaddrinfo EAI_AGAIN');
		Object.assign(error, { code: 'EAI_AGAIN' });
		expect(classifyConnectionError(error)).toBe('Connection error');
	});

	it('returns "Connection error" for ECONNREFUSED', () => {
		const error = new Error('connect ECONNREFUSED');
		Object.assign(error, { code: 'ECONNREFUSED' });
		expect(classifyConnectionError(error)).toBe('Connection error');
	});

	it('returns "Connection error" for EPROTO', () => {
		const error = new Error('SSL routines EPROTO');
		Object.assign(error, { code: 'EPROTO' });
		expect(classifyConnectionError(error)).toBe('Connection error');
	});

	// ── Cause chain traversal ──

	it('finds network error code in nested .cause (depth 1)', () => {
		const inner = new Error('inner error');
		Object.assign(inner, { code: 'ECONNRESET' });
		const outer = new Error('fetch failed', { cause: inner });
		expect(classifyConnectionError(outer)).toBe('Connection error');
	});

	it('finds network error code in deeply nested .cause (depth 3)', () => {
		const level3 = new Error('level 3');
		Object.assign(level3, { code: 'ETIMEDOUT' });
		const level2 = new Error('level 2', { cause: level3 });
		const level1 = new Error('level 1', { cause: level2 });
		const outer = new Error('outer', { cause: level1 });
		expect(classifyConnectionError(outer)).toBe('Network timeout');
	});

	it('does not traverse beyond MAX_CAUSE_DEPTH (5)', () => {
		// Build a chain of depth 6
		let error: Error = new Error('deepest');
		Object.assign(error, { code: 'ECONNRESET' });
		for (let index = 0; index < 5; index++) {
			error = new Error(`level ${index}`, { cause: error });
		}
		// The outer error is at depth 0, deepest is at depth 6 — beyond limit of 5
		expect(classifyConnectionError(error)).toBeUndefined();
	});

	// ── Message pattern matching ──

	it('detects "fetch failed" in error message', () => {
		expect(classifyConnectionError(new Error('fetch failed'))).toBe('Connection error');
	});

	it('detects "Fetch Failed" case-insensitively', () => {
		expect(classifyConnectionError(new Error('Fetch Failed: could not connect'))).toBe('Connection error');
	});

	it('detects "socket hang up"', () => {
		expect(classifyConnectionError(new Error('socket hang up'))).toBe('Connection error');
	});

	it('detects "network error"', () => {
		expect(classifyConnectionError(new Error('A network error occurred'))).toBe('Connection error');
	});

	it('detects SSL errors', () => {
		expect(classifyConnectionError(new Error('SSL error: certificate has expired'))).toBe('Connection error');
	});

	// ── Non-connection errors ──

	it('returns undefined for generic errors', () => {
		expect(classifyConnectionError(new Error('Something went wrong'))).toBeUndefined();
	});

	it('returns undefined for non-Error values', () => {
		expect(classifyConnectionError('string error')).toBeUndefined();
		expect(classifyConnectionError(42)).toBeUndefined();
		expect(classifyConnectionError()).toBeUndefined();
	});

	it('returns undefined for abort errors', () => {
		expect(classifyConnectionError(new DOMException('Aborted', 'AbortError'))).toBeUndefined();
	});
});

// =============================================================================
// classifyRetryableError
// =============================================================================

describe('classifyRetryableError', () => {
	// ── Existing retryable errors (unchanged behavior) ──

	it('returns reason for overloaded errors (529)', () => {
		const error = new Error('{"error":{"type":"overloaded_error","message":"Overloaded"}}');
		expect(classifyRetryableError(error)).toBeDefined();
	});

	it('returns reason for rate limit errors (429)', () => {
		const error = new Error('Rate limit exceeded');
		Object.assign(error, { response: new Response('', { status: 429 }) });
		expect(classifyRetryableError(error)).toBeDefined();
	});

	it('returns reason for server errors (5xx)', () => {
		const error = new Error('Internal server error');
		Object.assign(error, { response: new Response('', { status: 500 }) });
		expect(classifyRetryableError(error)).toBeDefined();
	});

	// ── Non-retryable errors ──

	it('returns undefined for abort errors', () => {
		const error = new DOMException('Aborted', 'AbortError');
		expect(classifyRetryableError(error)).toBeUndefined();
	});

	it('returns undefined for context overflow errors', () => {
		const error = new Error('The context window is too long');
		expect(classifyRetryableError(error)).toBeUndefined();
	});

	it('returns undefined for auth errors', () => {
		const error = new Error('Authentication failed');
		Object.assign(error, { response: new Response('', { status: 401 }) });
		expect(classifyRetryableError(error)).toBeUndefined();
	});

	it('returns undefined for invalid request errors', () => {
		const error = new Error('Bad request');
		Object.assign(error, { response: new Response('', { status: 400 }) });
		expect(classifyRetryableError(error)).toBeUndefined();
	});

	// ── Connection errors (new behavior) ──

	it('returns reason for ECONNRESET errors', () => {
		const error = new Error('read ECONNRESET');
		Object.assign(error, { code: 'ECONNRESET' });
		expect(classifyRetryableError(error)).toBe('Connection error');
	});

	it('returns reason for ETIMEDOUT errors', () => {
		const error = new Error('connect ETIMEDOUT');
		Object.assign(error, { code: 'ETIMEDOUT' });
		expect(classifyRetryableError(error)).toBe('Network timeout');
	});

	it('returns reason for "fetch failed" errors', () => {
		expect(classifyRetryableError(new Error('fetch failed'))).toBe('Connection error');
	});

	it('returns reason for ECONNREFUSED errors', () => {
		const error = new Error('connect ECONNREFUSED');
		Object.assign(error, { code: 'ECONNREFUSED' });
		expect(classifyRetryableError(error)).toBe('Connection error');
	});

	it('returns reason for nested network errors in cause chain', () => {
		const inner = new Error('inner');
		Object.assign(inner, { code: 'ENOTFOUND' });
		const outer = new Error('request failed', { cause: inner });
		expect(classifyRetryableError(outer)).toBe('Connection error');
	});

	it('returns reason for "socket hang up" errors', () => {
		expect(classifyRetryableError(new Error('socket hang up'))).toBe('Connection error');
	});
});

// =============================================================================
// calculateRetryDelay
// =============================================================================

describe('calculateRetryDelay', () => {
	it('returns exponential backoff for attempt 1', () => {
		expect(calculateRetryDelay(1)).toBe(2000);
	});

	it('returns exponential backoff for attempt 2', () => {
		expect(calculateRetryDelay(2)).toBe(4000);
	});

	it('returns exponential backoff for attempt 3', () => {
		expect(calculateRetryDelay(3)).toBe(8000);
	});

	it('caps delay at 30s without headers', () => {
		expect(calculateRetryDelay(10)).toBe(30_000);
	});

	it('uses retry-after-ms header when available', () => {
		const response = new Response('', {
			headers: { 'retry-after-ms': '5000' },
		});
		const error = Object.assign(new Error('rate limited'), { response });
		expect(calculateRetryDelay(1, error)).toBe(5000);
	});

	it('uses retry-after header in seconds', () => {
		const response = new Response('', {
			headers: { 'retry-after': '10' },
		});
		const error = Object.assign(new Error('rate limited'), { response });
		expect(calculateRetryDelay(1, error)).toBe(10_000);
	});
});

// =============================================================================
// sleep
// =============================================================================

describe('sleep', () => {
	it('resolves after the given delay', async () => {
		vi.useFakeTimers();
		const promise = sleep(1000);
		vi.advanceTimersByTime(1000);
		await expect(promise).resolves.toBeUndefined();
		vi.useRealTimers();
	});

	it('rejects immediately if signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(sleep(1000, controller.signal)).rejects.toThrow('Aborted');
	});

	it('rejects when signal is aborted during sleep', async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const promise = sleep(5000, controller.signal);
		controller.abort();
		await expect(promise).rejects.toThrow('Aborted');
		vi.useRealTimers();
	});
});
