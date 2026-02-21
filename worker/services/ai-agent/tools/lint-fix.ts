/**
 * Tool: lint_fix
 * Apply safe Biome lint fixes to a file.
 * Reads the file, applies safe autofixes via Biome WASM, and writes the result back.
 */

import fs from 'node:fs/promises';

import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { coordinatorNamespace } from '../../../lib/durable-object-namespaces';
import { isPathSafe } from '../../../lib/path-utilities';
import { recordFileRead } from '../file-time';
import { fixFileForAgent, formatLintResultsForAgent } from '../lib/biome-linter';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

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
	toolUseId?: string,
	queryChanges?: FileChange[],
): Promise<string> {
	const { projectRoot, projectId, sessionId } = context;
	const fixPath = input.path;

	if (!fixPath) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'Missing required parameter: path');
	}

	if (!isPathSafe(projectRoot, fixPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Path is outside project root: ${fixPath}`);
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

	if (!result) {
		return `File type not supported for lint fixing: ${fixPath}`;
	}

	if (result.fixCount === 0) {
		if (result.remainingDiagnostics.length === 0) {
			return `No lint issues found in ${fixPath}.`;
		}
		const lintInfo = await formatLintResultsForAgent(fixPath, originalContent);
		return `No auto-fixable lint issues in ${fixPath}. ${result.remainingDiagnostics.length} issue(s) require manual fixes.${lintInfo ?? ''}`;
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

	// Send file changed event for UI
	sendEvent('file_changed', {
		path: fixPath,
		action: 'edit',
		tool_use_id: toolUseId,
		beforeContent: originalContent,
		afterContent: result.fixedContent,
		isBinary: false,
	});

	// Build result message
	let message = `Fixed ${result.fixCount} lint issue(s) in ${fixPath}.`;

	if (result.remainingDiagnostics.length > 0) {
		message += `\n\n${result.remainingDiagnostics.length} issue(s) remain and require manual fixes:`;
		for (const diagnostic of result.remainingDiagnostics) {
			message += `\n  - line ${diagnostic.line}: ${diagnostic.message} (${diagnostic.rule})`;
		}
	}

	return message;
}
