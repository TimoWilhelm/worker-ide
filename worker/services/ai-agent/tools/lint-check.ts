/**
 * Tool: lint_check
 * Check a file for Biome lint issues without applying any fixes.
 * Reads the file, runs Biome lint diagnostics, and returns the results.
 */

import fs from 'node:fs/promises';

import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { isHiddenPath, isPathSafe } from '../../../lib/path-utilities';
import { formatLintDiagnostics, lintFileForAgent } from '../lib/biome-linter';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

// =============================================================================
// Description
// =============================================================================

export const DESCRIPTION = `Check a file for Biome lint issues without applying fixes.

Usage:
- Reads the file and runs Biome lint diagnostics to report any issues.
- Does NOT modify the file — this is a read-only check.
- Returns a summary of all lint diagnostics (errors and warnings) with line numbers, rules, and whether each issue is auto-fixable.
- Use this to inspect lint issues before deciding whether to fix them manually or with lint_fix.`;

// =============================================================================
// Definition
// =============================================================================

export const definition: ToolDefinition = {
	name: 'lint_check',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'The file path to check, relative to the project root (e.g. /src/app.tsx)',
			},
		},
		required: ['path'],
	},
};

// =============================================================================
// Execute
// =============================================================================

export async function execute(input: Record<string, string>, _sendEvent: SendEventFunction, context: ToolExecutorContext): Promise<string> {
	const { projectRoot } = context;
	const checkPath = input.path;

	if (!checkPath) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'Missing required parameter: path');
	}

	if (!isPathSafe(projectRoot, checkPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Path is outside project root: ${checkPath}`);
	}

	if (isHiddenPath(checkPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Access denied: ${checkPath}`);
	}

	// Read the file
	let content: string;
	try {
		content = await fs.readFile(`${projectRoot}${checkPath}`, 'utf8');
	} catch {
		return toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found: ${checkPath}`);
	}

	// Run lint diagnostics
	const diagnostics = await lintFileForAgent(checkPath, content);

	if (diagnostics.length === 0) {
		return `No lint issues found in ${checkPath}.`;
	}

	const formatted = formatLintDiagnostics(diagnostics);
	const fixableCount = diagnostics.filter((diagnostic) => diagnostic.fixable).length;

	let result = `Found ${diagnostics.length} lint issue(s) in ${checkPath}.\n${formatted}`;

	if (fixableCount > 0) {
		result += `\n\n${fixableCount} issue(s) can be auto-fixed with lint_fix.`;
	}

	return result;
}
