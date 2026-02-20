/**
 * Utility functions for the AI Agent Service.
 * Includes error parsing, validation helpers, and type guards.
 *
 * Tool call parsing logic (normalizeFunctionCallsFormat, parseToolCalls,
 * repairToolCallJson) has been moved to `./replicate/tool-call-parser.ts`
 * since it is specific to the Replicate text-completion adapter.
 */

import { BINARY_EXTENSIONS } from '@shared/constants';
import { toolInputSchemas, type ToolName } from '@shared/validation';

// =============================================================================
// Type Guards
// =============================================================================

export function isBinaryFilePath(path: string): boolean {
	const extension = path.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
	return BINARY_EXTENSIONS.has(extension);
}

/**
 * Type guard for ToolName.
 */
export function isToolName(name: string): name is ToolName {
	return name in toolInputSchemas;
}

/**
 * Type guard for checking if a value is a non-null object (not array).
 */
export function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// =============================================================================
// Error Helpers
// =============================================================================

/**
 * Safely extract the `response` property from an error object if it exists.
 */
function getErrorResponse(error: unknown): Response | undefined {
	if (isRecordObject(error) && 'response' in error) {
		const candidate = error.response;
		if (candidate instanceof Response) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Parse API errors into structured format.
 * Return type uses null for `code` because the result is serialized to JSON via SSE.
 */
export function parseApiError(error: unknown): { message: string; code: string | null } {
	const raw = error instanceof Error ? error.message : String(error);
	const response = getErrorResponse(error);
	const status = response?.status;

	let upstreamType: string | undefined;
	let upstreamMessage: string | undefined;
	try {
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			if (typeof parsed.detail === 'string') {
				const innerMatch = parsed.detail.match(/\{[\s\S]*\}/);
				if (innerMatch) {
					const inner = JSON.parse(innerMatch[0].replaceAll("'", '"'));
					upstreamType = inner?.error?.type || undefined;
					upstreamMessage = inner?.error?.message || parsed.detail;
				} else {
					upstreamMessage = parsed.detail;
				}
			}
			if (parsed?.error?.type) {
				upstreamType = parsed.error.type;
				upstreamMessage = parsed.error.message || upstreamMessage;
			}
		}
	} catch {
		// No-op
	}

	if (upstreamType === 'overloaded_error' || status === 529 || /overloaded/i.test(raw) || /529/.test(raw)) {
		return {
			message: upstreamMessage || 'The AI model is currently overloaded. Please try again in a moment.',
			code: 'OVERLOADED',
		};
	}
	if (upstreamType === 'rate_limit_error' || status === 429 || /rate.?limit/i.test(raw)) {
		return {
			message: upstreamMessage || 'Rate limit exceeded. Please wait before trying again.',
			code: 'RATE_LIMIT',
		};
	}
	if (upstreamType === 'authentication_error' || status === 401 || status === 403) {
		return {
			message: upstreamMessage || 'Authentication failed. The API token may be invalid or expired.',
			code: 'AUTH_ERROR',
		};
	}
	if (upstreamType === 'invalid_request_error' || status === 400) {
		return {
			message: upstreamMessage || 'The request was invalid.',
			code: 'INVALID_REQUEST',
		};
	}
	if (status && status >= 500) {
		return {
			message: upstreamMessage || 'The AI service encountered an internal error. Please try again.',
			code: 'SERVER_ERROR',
		};
	}
	if (error instanceof Error && error.name === 'AbortError') {
		return { message: 'Request was cancelled.', code: 'ABORTED' };
	}

	// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
	return { message: upstreamMessage || raw, code: null };
}

// =============================================================================
// Conversion Helpers
// =============================================================================

/**
 * Convert a buffer to Uint8Array safely without type assertions.
 */
export function toUint8Array(buffer: Buffer | Uint8Array): Uint8Array {
	if (buffer instanceof Uint8Array) {
		return buffer;
	}
	return new Uint8Array(buffer);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate tool input based on tool name.
 */
export function validateToolInput(
	toolName: ToolName,
	input: unknown,
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
	const schema = toolInputSchemas[toolName];
	if (!schema) {
		return { success: false, error: `Unknown tool: ${toolName}` };
	}

	const result = schema.safeParse(input);
	if (!result.success) {
		const formatted = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
		return { success: false, error: `Invalid input for ${toolName}: ${formatted}` };
	}

	return { success: true, data: result.data };
}
