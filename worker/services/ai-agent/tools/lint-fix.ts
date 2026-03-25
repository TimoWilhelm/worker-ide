/**
 * Tool: lint_fix
 * Apply safe Biome lint fixes to a file.
 * Reads the file, applies safe autofixes via Biome WASM, and writes the result back.
 */

import fs from 'node:fs/promises';

import { MAX_DIAGNOSTICS_PER_FILE } from '@shared/constants';
import { ToolErrorCode, toolError } from '@shared/tool-errors';
import { createHmrUpdateForFile } from '@shared/types';

import { coordinatorNamespace } from '../../../lib/durable-object-namespaces';
import { isHiddenPath, isPathSafe } from '../../../lib/path-utilities';
import { fixFile, formatLintDiagnostics, lintFile } from '../../../services/lint-service';
import { recordFileRead, withLock } from '../file-time';
import { computeDiffStats, generateCompactDiff } from '../utilities';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

// =============================================================================
// Description
// =============================================================================

const DESCRIPTION = `Apply safe Biome lint fixes to a file automatically.

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
			file_path: {
				type: 'string',
				description: 'The file path to fix, relative to the project root (e.g. /src/app.tsx)',
			},
		},
		required: ['file_path'],
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
	const fixPath = input.file_path;

	if (!fixPath) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'Missing required parameter: file_path');
	}

	if (!isPathSafe(projectRoot, fixPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Path is outside project root: ${fixPath}`);
	}

	if (isHiddenPath(fixPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Access denied: ${fixPath}`);
	}

	// Acquire a per-file lock so that a concurrent write tool cannot clobber
	// this fix, and so the recordFileRead timestamp stays accurate.
	type LockResult = ToolResult | { originalContent: string; fixedContent: string; fixCount: number };

	const lockResult: LockResult = await withLock(fixPath, async () => {
		// Read the file
		let originalContent: string;
		try {
			originalContent = await fs.readFile(`${projectRoot}${fixPath}`, 'utf8');
		} catch {
			return toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found: ${fixPath}`);
		}

		// Apply fixes
		const result = await fixFile(fixPath, originalContent);

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
			const allDiagnostics = await lintFile(fixPath, originalContent);
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

		return { originalContent, fixedContent: result.fixedContent, fixCount: result.fixCount };
	});

	if ('output' in lockResult) {
		return lockResult;
	}

	const { originalContent, fixedContent, fixCount } = lockResult;

	// Trigger HMR update (CSS/JS get hot updates, other files trigger full reload)
	const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
	const coordinatorStub = coordinatorNamespace.get(coordinatorId);
	await coordinatorStub.triggerUpdate(createHmrUpdateForFile(fixPath));

	// Compute diff stats and lint errors for the UI
	const { linesAdded, linesRemoved } = computeDiffStats(originalContent, fixedContent);
	const lintDiagnostics = await lintFile(fixPath, fixedContent);
	const limitedDiagnostics = lintDiagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);

	// Send file changed event for UI (carries full content for inline diff)
	sendEvent('file_changed', {
		path: fixPath,
		action: 'edit',
		beforeContent: originalContent,
		afterContent: fixedContent,
		isBinary: false,
	});

	// Build result with a compact diff so the model can see what changed
	let resultText = generateCompactDiff(fixPath, originalContent, fixedContent);
	resultText += `\n\nFixed ${fixCount} lint issue(s) in ${fixPath}.`;

	const lintOutput = formatLintDiagnostics(limitedDiagnostics);
	if (lintOutput) {
		resultText += `\n${lintOutput}`;
	}
	if (lintDiagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
		resultText += `\n(Showing ${MAX_DIAGNOSTICS_PER_FILE} of ${lintDiagnostics.length} diagnostics)`;
	}

	return {
		title: fixPath,
		metadata: { linesAdded, linesRemoved, fixedCount: fixCount, diagnostics: limitedDiagnostics },
		output: resultText,
	};
}
