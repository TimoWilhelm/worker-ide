/**
 * Tool: lint_check
 * Check a file for Biome lint issues without applying any fixes.
 * Reads the file, runs Biome lint diagnostics, and returns the results.
 */

import fs from 'node:fs/promises';

import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { isHiddenPath, isPathSafe } from '../../../lib/path-utilities';
import { formatLintDiagnostics, lintFileForAgent } from '../lib/biome-linter';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

// =============================================================================
// Constants
// =============================================================================

const MAX_DIAGNOSTICS_PER_FILE = 20;

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

export async function execute(
	input: Record<string, string>,
	_sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
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
	const allDiagnostics = await lintFileForAgent(checkPath, content);

	if (allDiagnostics.length === 0) {
		return {
			title: checkPath,
			metadata: { issueCount: 0, fixableCount: 0, diagnostics: [] },
			output: `No lint issues found in ${checkPath}.`,
		};
	}

	const fixableCount = allDiagnostics.filter((diagnostic) => diagnostic.fixable).length;
	const limitedDiagnostics = allDiagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);
	const formatted = formatLintDiagnostics(limitedDiagnostics);

	let result = `Found ${allDiagnostics.length} lint issue(s) in ${checkPath}.\n${formatted}`;

	if (fixableCount > 0) {
		result += `\n\n${fixableCount} issue(s) can be auto-fixed with lint_fix.`;
	}

	if (allDiagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
		result += `\n\n(Showing first ${MAX_DIAGNOSTICS_PER_FILE} of ${allDiagnostics.length} diagnostics.)`;
	}

	return {
		title: checkPath,
		metadata: { issueCount: allDiagnostics.length, fixableCount, diagnostics: limitedDiagnostics },
		output: result,
	};
}
