/**
 * Tool: file_multiedit
 * Apply multiple exact string replacements to a single file in one atomic operation.
 * All edits are applied sequentially; if any edit fails, none are written to disk.
 *
 * Prefer this tool over file_edit when making several changes to the same file.
 */

import fs from 'node:fs/promises';

import { MAX_DIAGNOSTICS_PER_FILE } from '@shared/constants';
import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { coordinatorNamespace } from '../../../lib/durable-object-namespaces';
import { isHiddenPath, isPathSafe } from '../../../lib/path-utilities';
import { assertFileWasRead, recordFileRead } from '../file-time';
import { formatLintDiagnostics, lintFileForAgent } from '../lib/biome-linter';
import { computeDiffStats, generateCompactDiff, isRecordObject } from '../utilities';
import { replace } from './replacers';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

// =============================================================================
// Description
// =============================================================================

export const DESCRIPTION = `Apply multiple exact string replacements to a single file in one atomic operation. All edits are applied sequentially; if any edit fails, none are written to disk.

Prefer this tool over \`file_edit\` when you need to make several changes to the same file — it is more efficient and avoids intermediate writes.

Usage:
CRITICAL INSTRUCTION: You MUST use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., \`1: \`). Everything after that space is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
CRITICAL INSTRUCTION: ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Each edit in the \`edits\` array contains \`old_string\`, \`new_string\`, and optional \`replace_all\`.
- Edits are applied in order; each edit operates on the result of the previous one.
- Plan your edits carefully so that earlier replacements do not affect text that later edits need to find.
- An edit will FAIL if \`old_string\` is not found in the (possibly already-modified) content.
- An edit will FAIL if \`old_string\` matches multiple locations (unless \`replace_all\` is \`"true"\`).`;

// =============================================================================
// Tool Definition
// =============================================================================

export const definition: ToolDefinition = {
	name: 'file_multiedit',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'The absolute path to the file to modify' },
			edits: {
				type: 'string',
				description:
					'A JSON array of edit objects. Each object has: "old_string" (text to find), "new_string" (replacement text), and optional "replace_all" ("true" to replace all occurrences). Example: [{"old_string":"foo","new_string":"bar"},{"old_string":"baz","new_string":"qux","replace_all":"true"}]',
			},
		},
		required: ['path', 'edits'],
	},
};

// =============================================================================
// Edit parsing
// =============================================================================

interface SingleEdit {
	old_string: string;
	new_string: string;
	replace_all?: string;
}

function parseEditsInput(raw: string): SingleEdit[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return toolError(ToolErrorCode.MISSING_INPUT, 'edits must be a valid JSON array of edit objects');
	}

	if (!Array.isArray(parsed) || parsed.length === 0) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'edits must be a non-empty JSON array');
	}

	const edits: SingleEdit[] = [];
	const items: unknown[] = parsed;
	for (const [index, item] of items.entries()) {
		if (!isRecordObject(item)) {
			return toolError(ToolErrorCode.MISSING_INPUT, `edits[${index}] must be an object with old_string and new_string`);
		}
		if (typeof item.old_string !== 'string' || item.old_string.length === 0) {
			return toolError(ToolErrorCode.MISSING_INPUT, `edits[${index}].old_string is required and must be a non-empty string`);
		}
		if (typeof item.new_string !== 'string') {
			return toolError(ToolErrorCode.MISSING_INPUT, `edits[${index}].new_string is required and must be a string`);
		}
		edits.push({
			old_string: item.old_string,
			new_string: item.new_string,
			replace_all: typeof item.replace_all === 'string' ? item.replace_all : undefined,
		});
	}
	return edits;
}

// =============================================================================
// Execute Function
// =============================================================================

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges?: FileChange[],
): Promise<ToolResult> {
	const { projectRoot, projectId, sessionId } = context;
	const editPath = input.path;
	const editsRaw = input.edits;

	// Validate path
	if (!isPathSafe(projectRoot, editPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, 'Invalid file path');
	}

	if (isHiddenPath(editPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Access denied: ${editPath}`);
	}

	// Parse edits array
	const edits = parseEditsInput(editsRaw);

	// Check that file was read first (if session tracking is available)
	if (sessionId) {
		try {
			await assertFileWasRead(projectRoot, sessionId, editPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'You must read the file before editing it.';
			const code = message.includes('has been modified since') ? ToolErrorCode.FILE_CHANGED_EXTERNALLY : ToolErrorCode.FILE_NOT_READ;
			return toolError(code, message);
		}
	}

	sendEvent('status', { message: `Editing ${editPath} (${edits.length} edit${edits.length === 1 ? '' : 's'})...` });

	// Read file content
	let content: string;
	try {
		content = await fs.readFile(`${projectRoot}${editPath}`, 'utf8');
	} catch {
		return toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found: ${editPath}`);
	}

	const beforeContent = content;

	// Apply all edits sequentially. On failure, no write happens (atomic).
	for (const [index, edit] of edits.entries()) {
		try {
			content = replace(content, edit.old_string, edit.new_string, edit.replace_all === 'true');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return toolError(ToolErrorCode.NO_MATCH, `Edit ${index + 1}/${edits.length} failed: ${message}`);
		}
	}

	// Guard: if all replacements produced no actual change, skip the write
	if (content === beforeContent) {
		return {
			title: editPath,
			metadata: { editCount: edits.length, linesAdded: 0, linesRemoved: 0, diagnostics: [] },
			output: 'No changes needed — the file already contains the expected content.',
		};
	}

	// Write the updated content
	await fs.writeFile(`${projectRoot}${editPath}`, content);

	// Record the edit as a read for subsequent edits
	if (sessionId) {
		await recordFileRead(projectRoot, sessionId, editPath);
	}

	// Track file change for snapshots
	if (queryChanges) {
		queryChanges.push({ path: editPath, action: 'edit', beforeContent, afterContent: content, isBinary: false });
	}

	// Trigger live reload
	const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
	const coordinatorStub = coordinatorNamespace.get(coordinatorId);
	const isCSS = editPath.endsWith('.css');
	await coordinatorStub.triggerUpdate({
		type: isCSS ? 'update' : 'full-reload',
		path: editPath,
		timestamp: Date.now(),
		isCSS,
	});

	// Compute diff stats and lint errors for the UI
	const { linesAdded, linesRemoved } = computeDiffStats(beforeContent, content);
	const allDiagnostics = await lintFileForAgent(editPath, content);
	const diagnostics = allDiagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);

	// Send file changed event for UI (carries full content for inline diff)
	sendEvent('file_changed', {
		path: editPath,
		action: 'edit',
		beforeContent,
		afterContent: content,
		isBinary: false,
	});

	// Build result with a compact diff so the model can verify its edits
	let output = generateCompactDiff(editPath, beforeContent, content);
	const lintOutput = formatLintDiagnostics(diagnostics);
	if (lintOutput) {
		output += `\n${lintOutput}`;
	}
	if (allDiagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
		output += `\n(Showing ${MAX_DIAGNOSTICS_PER_FILE} of ${allDiagnostics.length} diagnostics)`;
	}

	return {
		title: editPath,
		metadata: {
			editCount: edits.length,
			linesAdded,
			linesRemoved,
			diagnostics,
		},
		output,
	};
}
