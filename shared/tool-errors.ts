/**
 * Tool Error Codes
 *
 * Unique identifiers for tool errors, shared between worker (tools) and
 * frontend (UI). The worker embeds the code in `<error code="...">` tags;
 * the UI maps codes to short human-readable labels for inline display.
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
// Helpers
// =============================================================================

/**
 * Format a tool error string with an embedded code attribute.
 * Output: `<error code="CODE">Human-readable message</error>`
 */
export function toolError(code: ToolErrorCode, message: string): string {
	return `<error code="${code}">${message}</error>`;
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
