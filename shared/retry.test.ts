/**
 * Unit tests for the shared retry utility.
 */

import { describe, expect, it, vi } from 'vitest';

import { retry } from './retry';

describe('retry', () => {
	it('returns the result on first success', async () => {
		const function_ = vi.fn().mockResolvedValue('ok');
		const result = await retry(function_);
		expect(result).toBe('ok');
		expect(function_).toHaveBeenCalledTimes(1);
	});

	it('retries on failure and returns eventual success', async () => {
		const function_ = vi.fn().mockRejectedValueOnce(new Error('fail 1')).mockRejectedValueOnce(new Error('fail 2')).mockResolvedValue('ok');

		const result = await retry(function_, { maxAttempts: 3, baseDelayMs: 1 });
		expect(result).toBe('ok');
		expect(function_).toHaveBeenCalledTimes(3);
	});

	it('throws after exhausting all attempts', async () => {
		const function_ = vi.fn().mockRejectedValue(new Error('always fails'));

		await expect(retry(function_, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow('always fails');
		expect(function_).toHaveBeenCalledTimes(3);
	});

	it('respects shouldRetry predicate to bail early', async () => {
		const nonRetryableError = new Error('fatal');
		const function_ = vi.fn().mockRejectedValue(nonRetryableError);

		await expect(
			retry(function_, {
				maxAttempts: 5,
				baseDelayMs: 1,
				shouldRetry: () => false,
			}),
		).rejects.toThrow('fatal');
		// Should stop after 1 attempt because shouldRetry returns false
		expect(function_).toHaveBeenCalledTimes(1);
	});

	it('passes attempt number to shouldRetry', async () => {
		const shouldRetry = vi.fn().mockReturnValue(true);
		const function_ = vi.fn().mockRejectedValue(new Error('fail'));

		await expect(retry(function_, { maxAttempts: 3, baseDelayMs: 1, shouldRetry })).rejects.toThrow('fail');

		// shouldRetry is called for attempts 1 and 2 (not 3, since that's the last)
		expect(shouldRetry).toHaveBeenCalledTimes(2);
		expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 1);
		expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 2);
	});

	it('defaults to 3 attempts', async () => {
		const function_ = vi.fn().mockRejectedValue(new Error('fail'));

		await expect(retry(function_, { baseDelayMs: 1 })).rejects.toThrow('fail');
		expect(function_).toHaveBeenCalledTimes(3);
	});

	it('handles maxAttempts of 1 (no retries)', async () => {
		const function_ = vi.fn().mockRejectedValue(new Error('fail'));

		await expect(retry(function_, { maxAttempts: 1, baseDelayMs: 1 })).rejects.toThrow('fail');
		expect(function_).toHaveBeenCalledTimes(1);
	});

	it('clamps maxAttempts to at least 1', async () => {
		const function_ = vi.fn().mockRejectedValue(new Error('fail'));

		await expect(retry(function_, { maxAttempts: 0, baseDelayMs: 1 })).rejects.toThrow('fail');
		expect(function_).toHaveBeenCalledTimes(1);
	});
});
