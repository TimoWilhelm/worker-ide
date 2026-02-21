/**
 * Tool Error Codes
 *
 * Unique identifiers for tool errors, shared between worker (tools) and
 * frontend (UI). Tool executors call `toolError(code, message)` which throws
 * a `ToolExecutionError`. TanStack AI catches it and wraps it as
 * `{ error: "[CODE] message" }` with `state: 'output-error'`.
 *
 * The frontend detects errors via the `[CODE] message` prefix format and
 * maps codes to short human-readable labels for inline display.
 */

// =============================================================================
// Error Codes
// =============================================================================

export const ToolErrorCode = {
	INVALID_PATH: 'INVALID_PATH',
	FILE_NOT_FOUND: 'FILE_NOT_FOUND',
	FILE_NOT_READ: 'FILE_NOT_READ',
	FILE_CHANGED_EXTERNALLY: 'FILE_CHANGED_EXTERNALLY',
	NO_MATCH: 'NO_MATCH',
	MULTIPLE_MATCHES: 'MULTIPLE_MATCHES',
	NO_CHANGES: 'NO_CHANGES',
	INVALID_REGEX: 'INVALID_REGEX',
	PATCH_PARSE_FAILED: 'PATCH_PARSE_FAILED',
	PATCH_REJECTED: 'PATCH_REJECTED',
	PATCH_APPLY_FAILED: 'PATCH_APPLY_FAILED',
	NOT_ALLOWED: 'NOT_ALLOWED',
	MISSING_INPUT: 'MISSING_INPUT',
} as const;

export type ToolErrorCode = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

// =============================================================================
// Error Class
// =============================================================================

/**
 * Error thrown by tool executors to signal a tool-level failure.
 * The message uses `[CODE] description` format so the frontend can
 * extract the code and map it to a short label.
 */
export class ToolExecutionError extends Error {
	readonly code: ToolErrorCode;

	constructor(code: ToolErrorCode, message: string) {
		super(`[${code}] ${message}`);
		this.name = 'ToolExecutionError';
		this.code = code;
	}
}

// =============================================================================
// Helper
// =============================================================================

/**
 * Throw a `ToolExecutionError` with the given code and message.
 *
 * Usage in tool executors:
 * ```ts
 * toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found: ${path}`);
 * // or with return for type narrowing:
 * return toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found: ${path}`);
 * ```
 *
 * The return type is `never` so `return toolError(...)` is valid in functions
 * that return `string` or `Promise<string>`.
 */
export function toolError(code: ToolErrorCode, message: string): never {
	throw new ToolExecutionError(code, message);
}

// =============================================================================
// UI Label Map
// =============================================================================

/**
 * Short labels for each error code, used in the agent panel inline display.
 */
export const TOOL_ERROR_LABELS: Record<ToolErrorCode, string> = {
	INVALID_PATH: 'Invalid path',
	FILE_NOT_FOUND: 'File not found',
	FILE_NOT_READ: 'File not read',
	FILE_CHANGED_EXTERNALLY: 'File changed externally',
	NO_MATCH: 'No match found',
	MULTIPLE_MATCHES: 'Multiple matches',
	NO_CHANGES: 'No changes',
	INVALID_REGEX: 'Invalid regex',
	PATCH_PARSE_FAILED: 'Parse failed',
	PATCH_REJECTED: 'Patch rejected',
	PATCH_APPLY_FAILED: 'Patch failed',
	NOT_ALLOWED: 'Not allowed',
	MISSING_INPUT: 'Missing input',
};
