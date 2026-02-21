/**
 * Unit tests for tool error utilities.
 */

import { describe, expect, it } from 'vitest';

import { ToolErrorCode, ToolExecutionError, TOOL_ERROR_LABELS, toolError } from './tool-errors';

// =============================================================================
// ToolErrorCode
// =============================================================================

describe('ToolErrorCode', () => {
	it('contains all expected error codes', () => {
		expect(ToolErrorCode.INVALID_PATH).toBe('INVALID_PATH');
		expect(ToolErrorCode.FILE_NOT_FOUND).toBe('FILE_NOT_FOUND');
		expect(ToolErrorCode.FILE_NOT_READ).toBe('FILE_NOT_READ');
		expect(ToolErrorCode.FILE_CHANGED_EXTERNALLY).toBe('FILE_CHANGED_EXTERNALLY');
		expect(ToolErrorCode.NO_MATCH).toBe('NO_MATCH');
		expect(ToolErrorCode.MULTIPLE_MATCHES).toBe('MULTIPLE_MATCHES');
		expect(ToolErrorCode.NO_CHANGES).toBe('NO_CHANGES');
		expect(ToolErrorCode.INVALID_REGEX).toBe('INVALID_REGEX');
		expect(ToolErrorCode.PATCH_PARSE_FAILED).toBe('PATCH_PARSE_FAILED');
		expect(ToolErrorCode.PATCH_REJECTED).toBe('PATCH_REJECTED');
		expect(ToolErrorCode.PATCH_APPLY_FAILED).toBe('PATCH_APPLY_FAILED');
		expect(ToolErrorCode.NOT_ALLOWED).toBe('NOT_ALLOWED');
		expect(ToolErrorCode.MISSING_INPUT).toBe('MISSING_INPUT');
	});
});

// =============================================================================
// ToolExecutionError
// =============================================================================

describe('ToolExecutionError', () => {
	it('creates an error with [CODE] message format', () => {
		const error = new ToolExecutionError(ToolErrorCode.FILE_NOT_FOUND, 'File not found: /src/app.ts');
		expect(error.message).toBe('[FILE_NOT_FOUND] File not found: /src/app.ts');
	});

	it('stores the error code', () => {
		const error = new ToolExecutionError(ToolErrorCode.NO_MATCH, 'oldString not found');
		expect(error.code).toBe('NO_MATCH');
	});

	it('sets the name to ToolExecutionError', () => {
		const error = new ToolExecutionError(ToolErrorCode.INVALID_PATH, 'bad path');
		expect(error.name).toBe('ToolExecutionError');
	});

	it('is an instance of Error', () => {
		const error = new ToolExecutionError(ToolErrorCode.NOT_ALLOWED, 'nope');
		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(ToolExecutionError);
	});

	it('has a stack trace', () => {
		const error = new ToolExecutionError(ToolErrorCode.FILE_NOT_READ, 'must read first');
		expect(error.stack).toBeDefined();
	});
});

// =============================================================================
// toolError
// =============================================================================

describe('toolError', () => {
	it('throws a ToolExecutionError', () => {
		expect(() => toolError(ToolErrorCode.FILE_NOT_FOUND, 'gone')).toThrow(ToolExecutionError);
	});

	it('throws with [CODE] message format', () => {
		expect(() => toolError(ToolErrorCode.NO_MATCH, 'not found in content')).toThrow('[NO_MATCH] not found in content');
	});

	it('thrown error has the correct code', () => {
		try {
			toolError(ToolErrorCode.INVALID_REGEX, 'bad pattern');
		} catch (error) {
			expect(error).toBeInstanceOf(ToolExecutionError);
			if (error instanceof ToolExecutionError) {
				expect(error.code).toBe('INVALID_REGEX');
			}
			return;
		}
		// Should not reach here
		expect.unreachable('toolError did not throw');
	});
});

// =============================================================================
// TOOL_ERROR_LABELS
// =============================================================================

describe('TOOL_ERROR_LABELS', () => {
	it('has a label for every error code', () => {
		for (const code of Object.values(ToolErrorCode)) {
			expect(TOOL_ERROR_LABELS[code]).toBeDefined();
			expect(typeof TOOL_ERROR_LABELS[code]).toBe('string');
			expect(TOOL_ERROR_LABELS[code].length).toBeGreaterThan(0);
		}
	});

	it('returns expected labels for known codes', () => {
		expect(TOOL_ERROR_LABELS.FILE_NOT_FOUND).toBe('File not found');
		expect(TOOL_ERROR_LABELS.NO_MATCH).toBe('No match found');
		expect(TOOL_ERROR_LABELS.NOT_ALLOWED).toBe('Not allowed');
	});
});
