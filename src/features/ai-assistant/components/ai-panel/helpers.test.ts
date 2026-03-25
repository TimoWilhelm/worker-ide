/**
 * Unit tests for AI panel helper functions.
 */

import { describe, expect, it } from 'vitest';

import { toolInputSchemas } from '@shared/validation';

import { isToolName, isRecord } from './helpers';

// =============================================================================
// isToolName
// =============================================================================

describe('isToolName', () => {
	it('returns true for every tool name in toolInputSchemas', () => {
		for (const name of Object.keys(toolInputSchemas)) {
			expect(isToolName(name)).toBe(true);
		}
	});

	it('returns false for invalid tool names', () => {
		expect(isToolName('invalid_tool')).toBe(false);
		expect(isToolName('')).toBe(false);
		expect(isToolName(42)).toBe(false);
	});

	it('returns false for non-string values', () => {
		// eslint-disable-next-line unicorn/no-null -- testing null guard
		expect(isToolName(null)).toBe(false);
	});
});

// =============================================================================
// isRecord
// =============================================================================

describe('isRecord', () => {
	it('returns true for plain objects', () => {
		expect(isRecord({ key: 'value' })).toBe(true);
		expect(isRecord({})).toBe(true);
	});

	it('returns false for arrays', () => {
		expect(isRecord([1, 2, 3])).toBe(false);
	});

	it('returns false for primitives', () => {
		expect(isRecord('string')).toBe(false);
		expect(isRecord(42)).toBe(false);
	});

	it('returns false for nullish values', () => {
		// eslint-disable-next-line unicorn/no-null -- testing null guard
		expect(isRecord(null)).toBe(false);
	});
});
