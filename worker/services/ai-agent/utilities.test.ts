/**
 * Unit tests for AI Agent utility functions.
 */

import { describe, expect, it } from 'vitest';

import { isRecordObject, validateToolInput } from './utilities';

// =============================================================================
// isRecordObject
// =============================================================================

describe('isRecordObject', () => {
	it('returns true for plain objects', () => {
		expect(isRecordObject({})).toBe(true);
		expect(isRecordObject({ key: 'value' })).toBe(true);
	});

	it('returns false for arrays', () => {
		expect(isRecordObject([])).toBe(false);
		expect(isRecordObject([1, 2, 3])).toBe(false);
	});

	it('returns false for null and undefined', () => {
		// eslint-disable-next-line unicorn/no-null -- testing null behavior
		expect(isRecordObject(null)).toBe(false);
		expect(isRecordObject()).toBe(false);
	});

	it('returns false for primitives', () => {
		expect(isRecordObject('string')).toBe(false);
		expect(isRecordObject(42)).toBe(false);
		expect(isRecordObject(true)).toBe(false);
	});
});

// =============================================================================
// validateToolInput
// =============================================================================

describe('validateToolInput', () => {
	it('validates valid file_read input', () => {
		const result = validateToolInput('file_read', { path: '/index.html' });
		expect(result.success).toBe(true);
	});

	it('rejects invalid file_read input (missing path)', () => {
		const result = validateToolInput('file_read', {});
		expect(result.success).toBe(false);
	});
});
