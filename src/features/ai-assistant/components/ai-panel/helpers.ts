/**
 * Helper functions and constants for the AI Panel.
 */

import type { AIStreamEvent } from '@/lib/api-client';
import type { ToolName } from '@shared/types';

// =============================================================================
// Helper functions
// =============================================================================

const VALID_TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>([
	'file_edit',
	'file_write',
	'file_read',
	'file_grep',
	'file_glob',
	'file_list',
	'files_list',
	'file_patch',
	'file_delete',
	'file_move',
	'user_question',
	'web_fetch',
	'docs_search',
	'plan_update',
	'todos_get',
	'todos_update',
]);

export function isToolName(value: unknown): value is ToolName {
	return typeof value === 'string' && VALID_TOOL_NAMES.has(value);
}

export function getEventStringField(event: AIStreamEvent, field: string): string {
	const value = event[field];
	return typeof value === 'string' ? value : '';
}

export function getEventToolName(event: AIStreamEvent, field: string): ToolName {
	const value = event[field];
	if (isToolName(value)) {
		return value;
	}
	return 'files_list';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function getEventObjectField(event: AIStreamEvent, field: string): Record<string, unknown> {
	const value = event[field];
	return isRecord(value) ? value : {};
}

export function getEventBooleanField(event: AIStreamEvent, field: string): boolean | undefined {
	const value = event[field];
	return typeof value === 'boolean' ? value : undefined;
}

// =============================================================================
// AI Suggestion presets
// =============================================================================

export const AI_SUGGESTIONS = [
	{ label: 'Add dark mode', prompt: 'Add a dark mode toggle to the app' },
	{ label: 'Explain project', prompt: 'Explain what this project does' },
	{ label: 'Add validation', prompt: 'Add form validation to the input fields' },
];
