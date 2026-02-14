/**
 * Error codes and messages for the Worker IDE application.
 * Provides type-safe error handling across frontend and backend.
 */

/**
 * Error code constants
 */
export const ErrorCode = {
	// File system errors
	FILE_NOT_FOUND: 'FILE_NOT_FOUND',
	FILE_ALREADY_EXISTS: 'FILE_ALREADY_EXISTS',
	INVALID_PATH: 'INVALID_PATH',
	PROTECTED_FILE: 'PROTECTED_FILE',
	DIRECTORY_NOT_EMPTY: 'DIRECTORY_NOT_EMPTY',

	// Project errors
	PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
	PROJECT_EXPIRED: 'PROJECT_EXPIRED',

	// AI errors
	AI_RATE_LIMITED: 'AI_RATE_LIMITED',
	AI_OVERLOADED: 'AI_OVERLOADED',
	AI_AUTH_ERROR: 'AI_AUTH_ERROR',
	AI_INVALID_REQUEST: 'AI_INVALID_REQUEST',
	AI_SERVER_ERROR: 'AI_SERVER_ERROR',

	// Session errors
	SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
	INVALID_SESSION_ID: 'INVALID_SESSION_ID',

	// Snapshot errors
	SNAPSHOT_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',
	SNAPSHOT_REVERT_FAILED: 'SNAPSHOT_REVERT_FAILED',

	// Validation errors
	VALIDATION_ERROR: 'VALIDATION_ERROR',
	MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',

	// General errors
	INTERNAL_ERROR: 'INTERNAL_ERROR',
	NOT_FOUND: 'NOT_FOUND',
	UNAUTHORIZED: 'UNAUTHORIZED',
	FORBIDDEN: 'FORBIDDEN',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Human-readable error messages for each error code
 */
const ErrorMessages: Record<ErrorCodeType, string> = {
	[ErrorCode.FILE_NOT_FOUND]: 'File not found',
	[ErrorCode.FILE_ALREADY_EXISTS]: 'File already exists',
	[ErrorCode.INVALID_PATH]: 'Invalid file path',
	[ErrorCode.PROTECTED_FILE]: 'Cannot modify protected file',
	[ErrorCode.DIRECTORY_NOT_EMPTY]: 'Directory is not empty',

	[ErrorCode.PROJECT_NOT_FOUND]: 'Project not found',
	[ErrorCode.PROJECT_EXPIRED]: 'Project has expired',

	[ErrorCode.AI_RATE_LIMITED]: 'AI service rate limited. Please try again later.',
	[ErrorCode.AI_OVERLOADED]: 'AI service is overloaded. Please try again later.',
	[ErrorCode.AI_AUTH_ERROR]: 'AI service authentication failed',
	[ErrorCode.AI_INVALID_REQUEST]: 'Invalid AI request',
	[ErrorCode.AI_SERVER_ERROR]: 'AI service encountered an error',

	[ErrorCode.SESSION_NOT_FOUND]: 'Session not found',
	[ErrorCode.INVALID_SESSION_ID]: 'Invalid session ID',

	[ErrorCode.SNAPSHOT_NOT_FOUND]: 'Snapshot not found',
	[ErrorCode.SNAPSHOT_REVERT_FAILED]: 'Failed to revert snapshot',

	[ErrorCode.VALIDATION_ERROR]: 'Validation error',
	[ErrorCode.MISSING_REQUIRED_FIELD]: 'Missing required field',

	[ErrorCode.INTERNAL_ERROR]: 'Internal server error',
	[ErrorCode.NOT_FOUND]: 'Resource not found',
	[ErrorCode.UNAUTHORIZED]: 'Unauthorized',
	[ErrorCode.FORBIDDEN]: 'Forbidden',
};

/**
 * HTTP status codes for each error type
 */
const ErrorStatusCodes: Record<ErrorCodeType, number> = {
	[ErrorCode.FILE_NOT_FOUND]: 404,
	[ErrorCode.FILE_ALREADY_EXISTS]: 409,
	[ErrorCode.INVALID_PATH]: 400,
	[ErrorCode.PROTECTED_FILE]: 403,
	[ErrorCode.DIRECTORY_NOT_EMPTY]: 400,

	[ErrorCode.PROJECT_NOT_FOUND]: 404,
	[ErrorCode.PROJECT_EXPIRED]: 410,

	[ErrorCode.AI_RATE_LIMITED]: 429,
	[ErrorCode.AI_OVERLOADED]: 503,
	[ErrorCode.AI_AUTH_ERROR]: 401,
	[ErrorCode.AI_INVALID_REQUEST]: 400,
	[ErrorCode.AI_SERVER_ERROR]: 502,

	[ErrorCode.SESSION_NOT_FOUND]: 404,
	[ErrorCode.INVALID_SESSION_ID]: 400,

	[ErrorCode.SNAPSHOT_NOT_FOUND]: 404,
	[ErrorCode.SNAPSHOT_REVERT_FAILED]: 500,

	[ErrorCode.VALIDATION_ERROR]: 400,
	[ErrorCode.MISSING_REQUIRED_FIELD]: 400,

	[ErrorCode.INTERNAL_ERROR]: 500,
	[ErrorCode.NOT_FOUND]: 404,
	[ErrorCode.UNAUTHORIZED]: 401,
	[ErrorCode.FORBIDDEN]: 403,
};

/**
 * Structured error object
 */
export interface AppError {
	code: ErrorCodeType;
	message: string;
	details?: string;
}

/**
 * Create a structured error object
 */
export function createError(code: ErrorCodeType, customMessage?: string): AppError {
	return {
		code,
		message: customMessage ?? ErrorMessages[code],
	};
}

/**
 * Create a structured error with additional details
 */
export function createErrorWithDetails(code: ErrorCodeType, details: string): AppError {
	return {
		code,
		message: ErrorMessages[code],
		details,
	};
}

/**
 * Get the HTTP status code for an error code
 */
export function getErrorStatusCode(code: ErrorCodeType): number {
	return ErrorStatusCodes[code] ?? 500;
}

/**
 * Get the human-readable message for an error code
 */
export function getErrorMessage(code: ErrorCodeType): string {
	return ErrorMessages[code] ?? 'Unknown error';
}

/**
 * Type guard to check if a value is an AppError
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function isAppError(value: unknown): value is AppError {
	if (!isRecord(value)) return false;
	return typeof value.code === 'string' && typeof value.message === 'string';
}

/**
 * Parse API error response from Replicate AI service
 */
export function parseReplicateError(error: unknown): AppError {
	if (error instanceof Error) {
		const message = error.message.toLowerCase();

		if (message.includes('overloaded')) {
			return createError(ErrorCode.AI_OVERLOADED);
		}
		if (message.includes('rate') || message.includes('429')) {
			return createError(ErrorCode.AI_RATE_LIMITED);
		}
		if (message.includes('auth') || message.includes('401') || message.includes('unauthorized')) {
			return createError(ErrorCode.AI_AUTH_ERROR);
		}
		if (message.includes('invalid') || message.includes('400')) {
			return createError(ErrorCode.AI_INVALID_REQUEST, error.message);
		}

		return createError(ErrorCode.AI_SERVER_ERROR, error.message);
	}

	return createError(ErrorCode.AI_SERVER_ERROR);
}
