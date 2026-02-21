/**
 * Unit tests for AI panel helper functions.
 */

import { describe, expect, it } from 'vitest';

import { isToolName, isRecord, extractCustomEvent, getStringField, getNumberField } from './helpers';

// =============================================================================
// isToolName
// =============================================================================

describe('isToolName', () => {
	it('returns true for valid tool names', () => {
		expect(isToolName('file_edit')).toBe(true);
		expect(isToolName('file_write')).toBe(true);
		expect(isToolName('file_read')).toBe(true);
		expect(isToolName('file_grep')).toBe(true);
		expect(isToolName('file_glob')).toBe(true);
		expect(isToolName('file_list')).toBe(true);
		expect(isToolName('files_list')).toBe(true);
		expect(isToolName('file_delete')).toBe(true);
		expect(isToolName('file_move')).toBe(true);
		expect(isToolName('user_question')).toBe(true);
		expect(isToolName('web_fetch')).toBe(true);
		expect(isToolName('docs_search')).toBe(true);
		expect(isToolName('plan_update')).toBe(true);
		expect(isToolName('todos_get')).toBe(true);
		expect(isToolName('todos_update')).toBe(true);
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

// =============================================================================
// extractCustomEvent
// =============================================================================

describe('extractCustomEvent', () => {
	it('extracts data from a CUSTOM AG-UI event', () => {
		const chunk = { type: 'CUSTOM' as const, name: 'status', data: { message: 'Thinking...' }, timestamp: 12_345 };
		const result = extractCustomEvent(chunk);
		expect(result).toEqual({ name: 'status', data: { message: 'Thinking...' } });
	});

	it('returns undefined for non-CUSTOM events', () => {
		const chunk = { type: 'TEXT_MESSAGE_CONTENT' as const, messageId: 'msg-1', delta: 'hello', timestamp: 12_345 };
		expect(extractCustomEvent(chunk)).toBeUndefined();
	});

	it('returns empty data for CUSTOM event without data', () => {
		const chunk = { type: 'CUSTOM' as const, name: 'turn_complete', timestamp: 12_345 };
		const result = extractCustomEvent(chunk);
		expect(result).toEqual({ name: 'turn_complete', data: {} });
	});

	it('returns undefined for non-object chunks', () => {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- testing invalid input
		expect(extractCustomEvent('not an object' as never)).toBeUndefined();
	});
});

// =============================================================================
// getStringField
// =============================================================================

describe('getStringField', () => {
	it('returns string value for existing field', () => {
		expect(getStringField({ message: 'hello' }, 'message')).toBe('hello');
	});

	it('returns empty string for missing field', () => {
		expect(getStringField({}, 'message')).toBe('');
	});

	it('returns empty string for non-string field', () => {
		expect(getStringField({ count: 42 }, 'count')).toBe('');
	});
});

// =============================================================================
// getNumberField
// =============================================================================

describe('getNumberField', () => {
	it('returns number value for existing field', () => {
		expect(getNumberField({ count: 42 }, 'count')).toBe(42);
	});

	it('returns 0 for missing field', () => {
		expect(getNumberField({}, 'count')).toBe(0);
	});

	it('returns 0 for non-number field', () => {
		expect(getNumberField({ count: 'not a number' }, 'count')).toBe(0);
	});
});
