/**
 * Unit tests for error utilities.
 */

import { describe, expect, it } from 'vitest';

import {
	ErrorCode,
	createError,
	createErrorWithDetails,
	getErrorStatusCode,
	getErrorMessage,
	isAppError,
	parseReplicateError,
} from './errors';

// =============================================================================
// createError
// =============================================================================

describe('createError', () => {
	it('creates an error with default message', () => {
		const error = createError(ErrorCode.FILE_NOT_FOUND);
		expect(error.code).toBe('FILE_NOT_FOUND');
		expect(error.message).toBe('File not found');
		expect(error.details).toBeUndefined();
	});

	it('creates an error with custom message', () => {
		const error = createError(ErrorCode.FILE_NOT_FOUND, 'Could not find /src/main.ts');
		expect(error.code).toBe('FILE_NOT_FOUND');
		expect(error.message).toBe('Could not find /src/main.ts');
	});
});

// =============================================================================
// createErrorWithDetails
// =============================================================================

describe('createErrorWithDetails', () => {
	it('creates an error with details', () => {
		const error = createErrorWithDetails(ErrorCode.VALIDATION_ERROR, 'path must start with /');
		expect(error.code).toBe('VALIDATION_ERROR');
		expect(error.message).toBe('Validation error');
		expect(error.details).toBe('path must start with /');
	});
});

// =============================================================================
// getErrorStatusCode
// =============================================================================

describe('getErrorStatusCode', () => {
	it('returns 404 for FILE_NOT_FOUND', () => {
		expect(getErrorStatusCode(ErrorCode.FILE_NOT_FOUND)).toBe(404);
	});

	it('returns 409 for FILE_ALREADY_EXISTS', () => {
		expect(getErrorStatusCode(ErrorCode.FILE_ALREADY_EXISTS)).toBe(409);
	});

	it('returns 400 for INVALID_PATH', () => {
		expect(getErrorStatusCode(ErrorCode.INVALID_PATH)).toBe(400);
	});

	it('returns 403 for PROTECTED_FILE', () => {
		expect(getErrorStatusCode(ErrorCode.PROTECTED_FILE)).toBe(403);
	});

	it('returns 429 for AI_RATE_LIMITED', () => {
		expect(getErrorStatusCode(ErrorCode.AI_RATE_LIMITED)).toBe(429);
	});

	it('returns 503 for AI_OVERLOADED', () => {
		expect(getErrorStatusCode(ErrorCode.AI_OVERLOADED)).toBe(503);
	});

	it('returns 500 for INTERNAL_ERROR', () => {
		expect(getErrorStatusCode(ErrorCode.INTERNAL_ERROR)).toBe(500);
	});

	it('returns 410 for PROJECT_EXPIRED', () => {
		expect(getErrorStatusCode(ErrorCode.PROJECT_EXPIRED)).toBe(410);
	});
});

// =============================================================================
// getErrorMessage
// =============================================================================

describe('getErrorMessage', () => {
	it('returns message for known error code', () => {
		expect(getErrorMessage(ErrorCode.FILE_NOT_FOUND)).toBe('File not found');
	});

	it('returns message for AI errors', () => {
		expect(getErrorMessage(ErrorCode.AI_RATE_LIMITED)).toContain('rate limited');
	});

	it('returns message for session errors', () => {
		expect(getErrorMessage(ErrorCode.SESSION_NOT_FOUND)).toBe('Session not found');
	});
});

// =============================================================================
// isAppError
// =============================================================================

describe('isAppError', () => {
	it('returns true for valid AppError objects', () => {
		expect(isAppError({ code: 'FILE_NOT_FOUND', message: 'File not found' })).toBe(true);
	});

	it('returns true for AppError with details', () => {
		expect(isAppError({ code: 'VALIDATION_ERROR', message: 'Validation error', details: 'extra info' })).toBe(true);
	});

	it('returns false for non-object values', () => {
		expect(isAppError('string')).toBe(false);
		expect(isAppError(42)).toBe(false);
	});

	it('returns false for nullish values', () => {
		// eslint-disable-next-line unicorn/no-null -- testing null guard in isAppError
		expect(isAppError(null)).toBe(false);
		const nothing: unknown = undefined;
		expect(isAppError(nothing)).toBe(false);
	});

	it('returns false for objects missing code', () => {
		expect(isAppError({ message: 'hello' })).toBe(false);
	});

	it('returns false for objects missing message', () => {
		expect(isAppError({ code: 'FILE_NOT_FOUND' })).toBe(false);
	});

	it('returns false for arrays', () => {
		expect(isAppError([1, 2, 3])).toBe(false);
	});
});

// =============================================================================
// parseReplicateError
// =============================================================================

describe('parseReplicateError', () => {
	it('detects overloaded errors', () => {
		const error = parseReplicateError(new Error('Service is overloaded'));
		expect(error.code).toBe('AI_OVERLOADED');
	});

	it('detects rate limit errors', () => {
		const error = parseReplicateError(new Error('Rate limit exceeded'));
		expect(error.code).toBe('AI_RATE_LIMITED');
	});

	it('detects 429 errors', () => {
		const error = parseReplicateError(new Error('HTTP 429 Too Many Requests'));
		expect(error.code).toBe('AI_RATE_LIMITED');
	});

	it('detects auth errors', () => {
		const error = parseReplicateError(new Error('Authentication failed'));
		expect(error.code).toBe('AI_AUTH_ERROR');
	});

	it('detects 401 errors', () => {
		const error = parseReplicateError(new Error('HTTP 401 Unauthorized'));
		expect(error.code).toBe('AI_AUTH_ERROR');
	});

	it('detects invalid request errors', () => {
		const error = parseReplicateError(new Error('Invalid model parameter'));
		expect(error.code).toBe('AI_INVALID_REQUEST');
	});

	it('detects 400 errors', () => {
		const error = parseReplicateError(new Error('HTTP 400 Bad Request'));
		expect(error.code).toBe('AI_INVALID_REQUEST');
	});

	it('falls back to AI_SERVER_ERROR for unknown Error instances', () => {
		const error = parseReplicateError(new Error('Something went wrong'));
		expect(error.code).toBe('AI_SERVER_ERROR');
		expect(error.message).toBe('Something went wrong');
	});

	it('falls back to AI_SERVER_ERROR for non-Error values', () => {
		const error = parseReplicateError('just a string');
		expect(error.code).toBe('AI_SERVER_ERROR');
	});
});
