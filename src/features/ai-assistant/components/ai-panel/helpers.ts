/**
 * Helper functions and constants for the AI Panel.
 */

import type { AgentMode } from '@shared/types';
import type { ToolName } from '@shared/validation';
import type { StreamChunk } from '@tanstack/ai';

// =============================================================================
// Tool name validation
// =============================================================================

const VALID_TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>([
	'file_edit',
	'file_write',
	'file_read',
	'file_grep',
	'file_glob',
	'file_list',
	'files_list',

	'file_delete',
	'file_move',
	'user_question',
	'web_fetch',
	'docs_search',
	'plan_update',
	'todos_get',
	'todos_update',
	'dependencies_list',
	'dependencies_update',
	'lint_fix',
	'cdp_eval',
]);

export function isToolName(value: unknown): value is ToolName {
	return typeof value === 'string' && VALID_TOOL_NAMES.has(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

// =============================================================================
// CUSTOM AG-UI event helpers
// =============================================================================

/**
 * Data shape for CUSTOM events from the backend.
 * The backend emits: { type: 'CUSTOM', name: string, data?: unknown, timestamp: number }
 */
interface CustomEventData {
	name: string;
	data: Record<string, unknown>;
}

/**
 * Extract CUSTOM event data from a StreamChunk.
 * Returns undefined if the chunk is not a CUSTOM event.
 */
export function extractCustomEvent(chunk: StreamChunk): CustomEventData | undefined {
	if (!isRecord(chunk) || chunk.type !== 'CUSTOM') return undefined;
	const name = typeof chunk.name === 'string' ? chunk.name : '';
	const data = isRecord(chunk.data) ? chunk.data : {};
	return { name, data };
}

/**
 * Safely extract a string field from a record.
 */
export function getStringField(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	return typeof value === 'string' ? value : '';
}

/**
 * Safely extract a number field from a record.
 */
export function getNumberField(record: Record<string, unknown>, field: string): number {
	const value = record[field];
	return typeof value === 'number' ? value : 0;
}

// =============================================================================
// AI Suggestion presets
// =============================================================================

export const AI_SUGGESTIONS: ReadonlyArray<{ label: string; prompt: string; mode: AgentMode }> = [
	{ label: 'Add dark mode', prompt: 'Add a dark mode toggle to the app', mode: 'code' },
	{ label: 'Explain project', prompt: 'Explain what this project does', mode: 'ask' },
	{ label: 'Add validation', prompt: 'Add form validation to the input fields', mode: 'code' },
];
