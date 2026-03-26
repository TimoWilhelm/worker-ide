import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	constantTimeEqual,
	currentBucket,
	generatePreviewToken,
	PREVIEW_TOKEN_PATTERN,
	TOKEN_HEX_LENGTH,
	validatePreviewToken,
} from './preview-token';

const SECRET = 'test-secret-key';
const PROJECT_ID = 'abc123testproject';

// -- PREVIEW_TOKEN_PATTERN ----------------------------------------------------

describe('PREVIEW_TOKEN_PATTERN', () => {
	it('matches 12 lowercase hex characters', () => {
		expect(PREVIEW_TOKEN_PATTERN.test('a1b2c3d4e5f6')).toBe(true);
	});

	it('rejects uppercase hex', () => {
		expect(PREVIEW_TOKEN_PATTERN.test('A1B2C3D4E5F6')).toBe(false);
	});

	it('rejects too short', () => {
		expect(PREVIEW_TOKEN_PATTERN.test('a1b2c3')).toBe(false);
	});

	it('rejects too long', () => {
		expect(PREVIEW_TOKEN_PATTERN.test('a1b2c3d4e5f6a7')).toBe(false);
	});

	it('rejects non-hex characters', () => {
		expect(PREVIEW_TOKEN_PATTERN.test('g1h2i3j4k5l6')).toBe(false);
	});
});

// -- constantTimeEqual --------------------------------------------------------

describe('constantTimeEqual', () => {
	it('returns true for equal strings', () => {
		expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
	});

	it('returns false for different strings of same length', () => {
		expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
	});

	it('returns false for different-length strings', () => {
		expect(constantTimeEqual('abc', 'abcd')).toBe(false);
	});

	it('returns true for empty strings', () => {
		expect(constantTimeEqual('', '')).toBe(true);
	});
});

// -- currentBucket ------------------------------------------------------------

describe('currentBucket', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns floor(now_seconds / 3600)', () => {
		// Set time to exactly 2 hours after epoch
		vi.setSystemTime(new Date(2 * 3600 * 1000));
		expect(currentBucket()).toBe(2);
	});

	it('stays in the same bucket for the full hour', () => {
		vi.setSystemTime(new Date(3600 * 1000)); // start of bucket 1
		const bucketStart = currentBucket();

		vi.setSystemTime(new Date(3600 * 1000 + 3599 * 1000)); // end of bucket 1
		const bucketEnd = currentBucket();

		expect(bucketStart).toBe(bucketEnd);
	});

	it('increments at hour boundaries', () => {
		vi.setSystemTime(new Date(3600 * 1000 - 1)); // last ms of bucket 0
		const bucket0 = currentBucket();

		vi.setSystemTime(new Date(3600 * 1000)); // first ms of bucket 1
		const bucket1 = currentBucket();

		expect(bucket1).toBe(bucket0 + 1);
	});
});

// -- generatePreviewToken -----------------------------------------------------

describe('generatePreviewToken', () => {
	it('returns a string of TOKEN_HEX_LENGTH hex characters', async () => {
		const token = await generatePreviewToken(PROJECT_ID, SECRET);
		expect(token).toHaveLength(TOKEN_HEX_LENGTH);
		expect(PREVIEW_TOKEN_PATTERN.test(token)).toBe(true);
	});

	it('returns different tokens for different project IDs', async () => {
		const tokenA = await generatePreviewToken('project-a', SECRET);
		const tokenB = await generatePreviewToken('project-b', SECRET);
		expect(tokenA).not.toBe(tokenB);
	});

	it('returns different tokens for different secrets', async () => {
		const tokenA = await generatePreviewToken(PROJECT_ID, 'secret-a');
		const tokenB = await generatePreviewToken(PROJECT_ID, 'secret-b');
		expect(tokenA).not.toBe(tokenB);
	});

	it('returns the same token within the same time bucket', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(3600 * 1000 + 500));
		const tokenA = await generatePreviewToken(PROJECT_ID, SECRET);

		vi.setSystemTime(new Date(3600 * 1000 + 1000));
		const tokenB = await generatePreviewToken(PROJECT_ID, SECRET);

		expect(tokenA).toBe(tokenB);
		vi.useRealTimers();
	});
});

// -- validatePreviewToken -----------------------------------------------------

describe('validatePreviewToken', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('accepts a token generated in the current bucket', async () => {
		vi.setSystemTime(new Date(2 * 3600 * 1000 + 1000));
		const token = await generatePreviewToken(PROJECT_ID, SECRET);
		const isValid = await validatePreviewToken(PROJECT_ID, token, SECRET);
		expect(isValid).toBe(true);
	});

	it('accepts a token from the previous bucket', async () => {
		// Generate token in bucket N
		vi.setSystemTime(new Date(5 * 3600 * 1000 + 1000));
		const token = await generatePreviewToken(PROJECT_ID, SECRET);

		// Validate in bucket N+1
		vi.setSystemTime(new Date(6 * 3600 * 1000 + 1000));
		const isValid = await validatePreviewToken(PROJECT_ID, token, SECRET);
		expect(isValid).toBe(true);
	});

	it('rejects a token from two buckets ago', async () => {
		// Generate token in bucket N
		vi.setSystemTime(new Date(5 * 3600 * 1000 + 1000));
		const token = await generatePreviewToken(PROJECT_ID, SECRET);

		// Validate in bucket N+2
		vi.setSystemTime(new Date(7 * 3600 * 1000 + 1000));
		const isValid = await validatePreviewToken(PROJECT_ID, token, SECRET);
		expect(isValid).toBe(false);
	});

	it('rejects a token with the wrong secret', async () => {
		vi.setSystemTime(new Date(2 * 3600 * 1000));
		const token = await generatePreviewToken(PROJECT_ID, SECRET);
		const isValid = await validatePreviewToken(PROJECT_ID, token, 'wrong-secret');
		expect(isValid).toBe(false);
	});

	it('rejects a token for a different project ID', async () => {
		vi.setSystemTime(new Date(2 * 3600 * 1000));
		const token = await generatePreviewToken(PROJECT_ID, SECRET);
		const isValid = await validatePreviewToken('different-project', token, SECRET);
		expect(isValid).toBe(false);
	});

	it('rejects a malformed token', async () => {
		const isValid = await validatePreviewToken(PROJECT_ID, 'not-a-valid-token', SECRET);
		expect(isValid).toBe(false);
	});

	it('rejects an empty token', async () => {
		const isValid = await validatePreviewToken(PROJECT_ID, '', SECRET);
		expect(isValid).toBe(false);
	});
});
