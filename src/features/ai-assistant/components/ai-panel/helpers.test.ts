/**
 * Unit tests for AI panel helper functions.
 */

import { describe, expect, it } from 'vitest';

import { isToolName, getEventStringField, getEventToolName, isRecord, getEventObjectField, getEventBooleanField } from './helpers';

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
		expect(isToolName('file_patch')).toBe(true);
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
// getEventStringField
// =============================================================================

describe('getEventStringField', () => {
	it('returns string value for existing field', () => {
		const event = { type: 'text', text: 'hello' };
		expect(getEventStringField(event, 'text')).toBe('hello');
	});

	it('returns empty string for missing field', () => {
		const event = { type: 'text' };
		expect(getEventStringField(event, 'text')).toBe('');
	});

	it('returns empty string for non-string field', () => {
		const event = { type: 'text', count: 42 };
		expect(getEventStringField(event, 'count')).toBe('');
	});
});

// =============================================================================
// getEventToolName
// =============================================================================

describe('getEventToolName', () => {
	it('returns tool name for valid field', () => {
		const event = { type: 'tool_use', name: 'file_read' };
		expect(getEventToolName(event, 'name')).toBe('file_read');
	});

	it('returns files_list as fallback for invalid tool name', () => {
		const event = { type: 'tool_use', name: 'unknown_tool' };
		expect(getEventToolName(event, 'name')).toBe('files_list');
	});

	it('returns files_list as fallback for missing field', () => {
		const event = { type: 'tool_use' };
		expect(getEventToolName(event, 'name')).toBe('files_list');
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
// getEventObjectField
// =============================================================================

describe('getEventObjectField', () => {
	it('returns object for valid field', () => {
		const event = { type: 'tool_use', input: { path: '/src/main.ts' } };
		expect(getEventObjectField(event, 'input')).toEqual({ path: '/src/main.ts' });
	});

	it('returns empty object for missing field', () => {
		const event = { type: 'tool_use' };
		expect(getEventObjectField(event, 'input')).toEqual({});
	});

	it('returns empty object for non-object field', () => {
		const event = { type: 'tool_use', input: 'not an object' };
		expect(getEventObjectField(event, 'input')).toEqual({});
	});
});

// =============================================================================
// getEventBooleanField
// =============================================================================

describe('getEventBooleanField', () => {
	it('returns boolean value for boolean field', () => {
		const event = { type: 'tool_result', is_error: true };
		expect(getEventBooleanField(event, 'is_error')).toBe(true);
	});

	it('returns undefined for missing field', () => {
		const event = { type: 'tool_result' };
		expect(getEventBooleanField(event, 'is_error')).toBeUndefined();
	});

	it('returns undefined for non-boolean field', () => {
		const event = { type: 'tool_result', is_error: 'yes' };
		expect(getEventBooleanField(event, 'is_error')).toBeUndefined();
	});
});
