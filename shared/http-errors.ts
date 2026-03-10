/**
 * HTTP Error Codes
 *
 * Strongly typed error codes shared between backend routes and frontend API
 * consumers. Every `httpError()` call in the worker routes uses one of these
 * codes, and the frontend `throwApiError()` helper extracts it from the
 * response body to enable conditional error handling and to surface the
 * server's descriptive message to users.
 *
 * Wire format: `{ error: string; code: HttpErrorCode }`
 *
 * This module is intentionally separate from `shared/tool-errors.ts`, which
 * covers AI agent tool execution failures (a different error domain).
 */

// =============================================================================
// Error Codes
// =============================================================================

export const HttpErrorCode = {
	// File system
	FILE_NOT_FOUND: 'FILE_NOT_FOUND',
	INVALID_PATH: 'INVALID_PATH',
	PROTECTED_FILE: 'PROTECTED_FILE',

	// Git
	GIT_OPERATION_FAILED: 'GIT_OPERATION_FAILED',

	// Validation
	VALIDATION_ERROR: 'VALIDATION_ERROR',

	// Auth / rate limiting
	RATE_LIMITED: 'RATE_LIMITED',
	NOT_CONFIGURED: 'NOT_CONFIGURED',

	// Resources
	NOT_FOUND: 'NOT_FOUND',
	SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
	SNAPSHOT_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',

	// Build / deploy
	BUILD_FAILED: 'BUILD_FAILED',
	UPSTREAM_ERROR: 'UPSTREAM_ERROR',

	// Data integrity
	DATA_CORRUPTED: 'DATA_CORRUPTED',

	// General
	INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type HttpErrorCode = (typeof HttpErrorCode)[keyof typeof HttpErrorCode];

// =============================================================================
// Default Status Codes
// =============================================================================

/**
 * Default HTTP status code for each error code.
 *
 * `httpError()` uses this map when no explicit status is provided, so callers
 * can write `httpError(HttpErrorCode.FILE_NOT_FOUND, 'File not found')` without
 * repeating the `404`.
 */
export const DEFAULT_STATUS_CODES: Record<HttpErrorCode, number> = {
	[HttpErrorCode.FILE_NOT_FOUND]: 404,
	[HttpErrorCode.INVALID_PATH]: 400,
	[HttpErrorCode.PROTECTED_FILE]: 403,

	[HttpErrorCode.GIT_OPERATION_FAILED]: 500,

	[HttpErrorCode.VALIDATION_ERROR]: 400,

	[HttpErrorCode.RATE_LIMITED]: 429,
	[HttpErrorCode.NOT_CONFIGURED]: 500,

	[HttpErrorCode.NOT_FOUND]: 404,
	[HttpErrorCode.SESSION_NOT_FOUND]: 404,
	[HttpErrorCode.SNAPSHOT_NOT_FOUND]: 404,

	[HttpErrorCode.BUILD_FAILED]: 400,
	[HttpErrorCode.UPSTREAM_ERROR]: 502,

	[HttpErrorCode.DATA_CORRUPTED]: 422,

	[HttpErrorCode.INTERNAL_ERROR]: 500,
};
