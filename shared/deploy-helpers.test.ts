import { describe, expect, it } from 'vitest';

import { sanitizeR2BucketName, sanitizeWorkerName } from './deploy-helpers';

describe('sanitizeWorkerName', () => {
	it('lowercases uppercase characters', () => {
		expect(sanitizeWorkerName('MyWorker')).toBe('myworker');
	});

	it('replaces non-alphanumeric characters with hyphens', () => {
		expect(sanitizeWorkerName('my worker app')).toBe('my-worker-app');
	});

	it('collapses multiple hyphens into one', () => {
		expect(sanitizeWorkerName('my---worker')).toBe('my-worker');
	});

	it('strips leading and trailing hyphens', () => {
		expect(sanitizeWorkerName('-my-worker-')).toBe('my-worker');
	});

	it('handles special characters', () => {
		expect(sanitizeWorkerName('my_worker@v2')).toBe('my-worker-v2');
	});

	it('truncates to 63 characters', () => {
		const longName = 'a'.repeat(100);
		expect(sanitizeWorkerName(longName)).toHaveLength(63);
	});

	it('returns my-worker for empty string', () => {
		expect(sanitizeWorkerName('')).toBe('my-worker');
	});

	it('returns my-worker for string of only special characters', () => {
		expect(sanitizeWorkerName('!!!')).toBe('my-worker');
	});

	it('preserves valid names unchanged', () => {
		expect(sanitizeWorkerName('my-worker-123')).toBe('my-worker-123');
	});
});

describe('sanitizeR2BucketName', () => {
	it('appends a deterministic -storage hash suffix to worker name', () => {
		expect(sanitizeR2BucketName('my-worker')).toMatch(/^my-worker-storage-[\da-f]{8}$/);
	});

	it('lowercases and sanitizes the name', () => {
		expect(sanitizeR2BucketName('My Worker')).toMatch(/^my-worker-storage-[\da-f]{8}$/);
	});

	it('handles special characters', () => {
		expect(sanitizeR2BucketName('my_worker@v2')).toMatch(/^my-worker-v2-storage-[\da-f]{8}$/);
	});

	it('truncates long names to fit within 63 chars', () => {
		const longName = 'a'.repeat(100);
		const result = sanitizeR2BucketName(longName);
		expect(result.length).toBeLessThanOrEqual(63);
		expect(result).toMatch(/-storage-[\da-f]{8}$/);
	});

	it('returns a valid app fallback for empty input', () => {
		expect(sanitizeR2BucketName('')).toMatch(/^app-storage-[\da-f]{8}$/);
	});

	it('returns a valid app fallback for only special characters', () => {
		expect(sanitizeR2BucketName('!!!')).toMatch(/^app-storage-[\da-f]{8}$/);
	});

	it('produces names with minimum 3 characters', () => {
		const result = sanitizeR2BucketName('a');
		expect(result.length).toBeGreaterThanOrEqual(3);
	});

	it('does not produce leading or trailing hyphens', () => {
		const result = sanitizeR2BucketName('-test-');
		expect(result).not.toMatch(/^-/);
		expect(result).not.toMatch(/-$/);
	});

	it('preserves leading digits when they are part of a valid bucket name', () => {
		expect(sanitizeR2BucketName('123-my-app')).toMatch(/^123-my-app-storage-[\da-f]{8}$/);
	});

	it('preserves digit-only names when they are valid bucket names', () => {
		expect(sanitizeR2BucketName('12345')).toMatch(/^12345-storage-[\da-f]{8}$/);
	});

	it('avoids collisions for names that previously normalized to the same bucket', () => {
		expect(sanitizeR2BucketName('123-my-app')).not.toBe(sanitizeR2BucketName('my-app'));
	});

	it('avoids collisions for long names that share the same truncated prefix', () => {
		const first = sanitizeR2BucketName(`${'a'.repeat(80)}-one`);
		const second = sanitizeR2BucketName(`${'a'.repeat(80)}-two`);
		expect(first).not.toBe(second);
	});
});
