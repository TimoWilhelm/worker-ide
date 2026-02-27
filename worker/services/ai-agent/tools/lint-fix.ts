/**
 * Tool: lint_fix
 * Apply safe Biome lint fixes to a file.
 * Reads the file, applies safe autofixes via Biome WASM, and writes the result back.
 */

import fs from 'node:fs/promises';

import { MAX_DIAGNOSTICS_PER_FILE } from '@shared/constants';
import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { coordinatorNamespace } from '../../../lib/durable-object-namespaces';
import { isHiddenPath, isPathSafe } from '../../../lib/path-utilities';
import { recordFileRead } from '../file-time';
import { fixFileForAgent, formatLintDiagnostics, lintFileForAgent } from '../lib/biome-linter';
import { computeDiffStats, generateCompactDiff } from '../utilities';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

// =============================================================================
// Description
// =============================================================================

export const DESCRIPTION = `Apply safe Biome lint fixes to a file automatically.

Usage:
- Reads the file, applies all safe lint autofixes using Biome, and writes the fixed content back.
- Only applies "safe" fixes that do not change program behavior.
- Returns a summary of fixes applied and any remaining diagnostics that require manual attention.
- Use this after writing or editing files to clean up lint issues automatically.`;

// =============================================================================
// Definition
// =============================================================================

export const definition: ToolDefinition = {
	name: 'lint_fix',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'The file path to fix, relative to the project root (e.g. /src/app.tsx)',
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
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges?: FileChange[],
): Promise<ToolResult> {
	const { projectRoot, projectId, sessionId } = context;
	const fixPath = input.path;

	if (!fixPath) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'Missing required parameter: path');
	}

	if (!isPathSafe(projectRoot, fixPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Path is outside project root: ${fixPath}`);
	}

	if (isHiddenPath(fixPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Access denied: ${fixPath}`);
	}

	// Read the file
	let originalContent: string;
	try {
		originalContent = await fs.readFile(`${projectRoot}${fixPath}`, 'utf8');
	} catch {
		return toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found: ${fixPath}`);
	}

	// Apply fixes
	const result = await fixFileForAgent(fixPath, originalContent);

	if ('failed' in result) {
		return toolError(ToolErrorCode.LINT_FIX_FAILED, result.reason);
	}

	if (result.fixCount === 0) {
		if (result.remainingDiagnostics.length === 0) {
			return {
				title: fixPath,
				metadata: { linesAdded: 0, linesRemoved: 0, fixedCount: 0, diagnostics: [] },
				output: `No lint issues found in ${fixPath}.`,
			};
		}
		const allDiagnostics = await lintFileForAgent(fixPath, originalContent);
		const diagnostics = allDiagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);
		let noFixOutput = `No auto-fixable lint issues in ${fixPath}. ${result.remainingDiagnostics.length} issue(s) require manual fixes.`;
		const lintOutput = formatLintDiagnostics(diagnostics);
		if (lintOutput) {
			noFixOutput += `\n${lintOutput}`;
		}
		if (allDiagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
			noFixOutput += `\n(Showing ${MAX_DIAGNOSTICS_PER_FILE} of ${allDiagnostics.length} diagnostics)`;
		}
		return {
			title: fixPath,
			metadata: { linesAdded: 0, linesRemoved: 0, fixedCount: 0, diagnostics },
			output: noFixOutput,
		};
	}

	// Write the fixed content
	await fs.writeFile(`${projectRoot}${fixPath}`, result.fixedContent);

	// Record as read for subsequent operations
	if (sessionId) {
		await recordFileRead(projectRoot, sessionId, fixPath);
	}

	// Track file change for snapshots
	if (queryChanges) {
		queryChanges.push({
			path: fixPath,
			action: 'edit',
			beforeContent: originalContent,
			afterContent: result.fixedContent,
			isBinary: false,
		});
	}

	// Trigger live reload
	const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
	const coordinatorStub = coordinatorNamespace.get(coordinatorId);
	const isCSS = fixPath.endsWith('.css');
	await coordinatorStub.triggerUpdate({
		type: isCSS ? 'update' : 'full-reload',
		path: fixPath,
		timestamp: Date.now(),
		isCSS,
	});

	// Compute diff stats and lint errors for the UI
	const { linesAdded, linesRemoved } = computeDiffStats(originalContent, result.fixedContent);
	const lintDiagnostics = await lintFileForAgent(fixPath, result.fixedContent);
	const limitedDiagnostics = lintDiagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);

	// Send file changed event for UI (carries full content for inline diff)
	sendEvent('file_changed', {
		path: fixPath,
		action: 'edit',
		beforeContent: originalContent,
		afterContent: result.fixedContent,
		isBinary: false,
	});

	// Build result with a compact diff so the model can see what changed
	let resultText = generateCompactDiff(fixPath, originalContent, result.fixedContent);
	resultText += `\n\nFixed ${result.fixCount} lint issue(s) in ${fixPath}.`;

	const lintOutput = formatLintDiagnostics(limitedDiagnostics);
	if (lintOutput) {
		resultText += `\n${lintOutput}`;
	}
	if (lintDiagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
		resultText += `\n(Showing ${MAX_DIAGNOSTICS_PER_FILE} of ${lintDiagnostics.length} diagnostics)`;
	}

	return {
		title: fixPath,
		metadata: { linesAdded, linesRemoved, fixedCount: result.fixCount, diagnostics: limitedDiagnostics },
		output: resultText,
	};
}
