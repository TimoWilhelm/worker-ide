/**
 * Tool: file_edit
 * Modify existing files using exact string replacements.
 * Uses multiple replacement strategies for robust matching.
 */

import fs from 'node:fs/promises';

import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { coordinatorNamespace } from '../../../lib/durable-object-namespaces';
import { isHiddenPath, isPathSafe } from '../../../lib/path-utilities';
import { assertFileWasRead, recordFileRead } from '../file-time';
import { replace } from './replacers';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

// =============================================================================
// Description (matches OpenCode)
// =============================================================================

export const DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., \`1: \`). Everything after that space is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- The edit will FAIL if \`oldString\` is not found in the file with an error "oldString not found in content".
- The edit will FAIL if \`oldString\` is found multiple times in the file with an error "Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match." Either provide a larger string with more surrounding context to make it unique or use \`replaceAll\` to change every instance of \`oldString\`.
- Use \`replaceAll\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`;

// =============================================================================
// Tool Definition
// =============================================================================

export const definition: ToolDefinition = {
	name: 'file_edit',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'The absolute path to the file to modify' },
			old_string: { type: 'string', description: 'The text to replace' },
			new_string: { type: 'string', description: 'The text to replace it with (must be different from old_string)' },
			replace_all: { type: 'string', description: 'Replace all occurrences of old_string (default false). Set to "true" to enable.' },
		},
		required: ['path', 'old_string', 'new_string'],
	},
};

// =============================================================================
// Execute Function
// =============================================================================

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	toolUseId?: string,
	queryChanges?: FileChange[],
): Promise<string> {
	const { projectRoot, projectId, sessionId } = context;
	const editPath = input.path;
	const oldString = input.old_string;
	const newString = input.new_string;
	const shouldReplaceAll = input.replace_all === 'true';

	// Validate path
	if (!isPathSafe(projectRoot, editPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, 'Invalid file path');
	}

	if (isHiddenPath(editPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Access denied: ${editPath}`);
	}

	// Check that file was read first (if session tracking is available)
	if (sessionId) {
		try {
			await assertFileWasRead(projectRoot, sessionId, editPath);
		} catch (error) {
			return toolError(ToolErrorCode.FILE_NOT_READ, error instanceof Error ? error.message : 'You must read the file before editing it.');
		}
	}

	await sendEvent('status', { message: `Editing ${editPath}...` });

	// Read file content
	let content: string;
	try {
		content = await fs.readFile(`${projectRoot}${editPath}`, 'utf8');
	} catch {
		return toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found: ${editPath}`);
	}

	const beforeContent = content;

	// Use the replace function with multiple strategies
	try {
		content = replace(content, oldString, newString, shouldReplaceAll);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return toolError(ToolErrorCode.NO_MATCH, message);
	}

	// Guard: if the replacement produced no actual change (e.g., fuzzy match found
	// content that after substitution is identical), skip the write and return early.
	// This prevents empty diffs from appearing in the UI.
	if (content === beforeContent) {
		return 'No changes needed — the file already contains the expected content.';
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

	// Send file changed event for UI
	await sendEvent('file_changed', {
		path: editPath,
		action: 'edit',
		tool_use_id: toolUseId,
		beforeContent,
		afterContent: content,
		isBinary: false,
	});

	return 'Edit applied successfully.';
}
