/**
 * Helper functions and constants for the AI Panel.
 */

import { toolInputSchemas } from '@shared/validation';

import type { AgentMode } from '@shared/types';
import type { ToolName } from '@shared/validation';

// =============================================================================
// Tool name validation
// =============================================================================

/**
 * Derived from toolInputSchemas — adding a new tool to shared/validation.ts
 * automatically makes it recognized here. No manual list to keep in sync.
 */
const VALID_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(toolInputSchemas));

export function isToolName(value: unknown): value is ToolName {
	return typeof value === 'string' && VALID_TOOL_NAMES.has(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

// =============================================================================
// AI Suggestion presets
// =============================================================================

export const AI_SUGGESTIONS: ReadonlyArray<{ label: string; prompt: string; mode: AgentMode }> = [
	{ label: 'Add dark mode', prompt: 'Add a dark mode toggle to the app', mode: 'code' },
	{ label: 'Explain project', prompt: 'Explain what this project does', mode: 'ask' },
	{ label: 'Add validation', prompt: 'Add form validation to the input fields', mode: 'code' },
];
