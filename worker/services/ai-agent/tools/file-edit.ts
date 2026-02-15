/**
 * Tool: file_edit
 * Modify existing files using exact string replacements.
 */

import fs from 'node:fs/promises';

import { isPathSafe } from '../../../lib/path-utilities';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Performs exact string replacements in files. Finds old_string in the file and replaces it with new_string.

Usage:
- You MUST use the file_read tool at least once before editing a file. This tool will error if you attempt an edit without reading the file first.
- When editing text from file_read output, preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- The edit will FAIL if old_string is not found in the file.
- The edit will FAIL if old_string matches multiple times. Either provide a larger string with more surrounding context to make it unique, or use replace_all: "true" to change every instance.
- Use replace_all for replacing and renaming strings across the file. This is useful for renaming a variable, for instance.`;

export const definition: ToolDefinition = {
	name: 'file_edit',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path starting with /, e.g., /src/main.ts' },
			old_string: { type: 'string', description: 'The exact text to find and replace' },
			new_string: { type: 'string', description: 'The replacement text' },
			replace_all: { type: 'string', description: 'Set to "true" to replace all occurrences (default: first only)' },
		},
		required: ['path', 'old_string', 'new_string'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	toolUseId?: string,
	queryChanges?: FileChange[],
): Promise<string | object> {
	const { projectRoot, projectId, environment } = context;
	const path = input.path;
	const oldString = input.old_string;
	const newString = input.new_string;
	const shouldReplaceAll = input.replace_all === 'true';

	if (!isPathSafe(projectRoot, path)) {
		return { error: 'Invalid file path' };
	}

	await sendEvent('status', { message: `Editing ${path}...` });

	let content: string;
	try {
		content = await fs.readFile(`${projectRoot}${path}`, 'utf8');
	} catch {
		return { error: `File not found: ${path}` };
	}

	const beforeContent = content;

	if (shouldReplaceAll) {
		if (!content.includes(oldString)) {
			return { error: `old_string not found in ${path}` };
		}
		content = content.replaceAll(oldString, newString);
	} else {
		const firstIndex = content.indexOf(oldString);
		if (firstIndex === -1) {
			return { error: `old_string not found in ${path}` };
		}
		const secondIndex = content.indexOf(oldString, firstIndex + oldString.length);
		if (secondIndex !== -1) {
			return {
				error: `old_string matches multiple times in ${path}. Use replace_all: "true" to replace all, or provide a more specific old_string.`,
			};
		}
		content = content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length);
	}

	await fs.writeFile(`${projectRoot}${path}`, content);

	if (queryChanges) {
		queryChanges.push({ path, action: 'edit', beforeContent, afterContent: content, isBinary: false });
	}

	const coordinatorId = environment.DO_PROJECT_COORDINATOR.idFromName(`project:${projectId}`);
	const coordinatorStub = environment.DO_PROJECT_COORDINATOR.get(coordinatorId);
	const isCSS = path.endsWith('.css');
	await coordinatorStub.triggerUpdate({
		type: isCSS ? 'update' : 'full-reload',
		path,
		timestamp: Date.now(),
		isCSS,
	});

	await sendEvent('file_changed', {
		path,
		action: 'edit',
		tool_use_id: toolUseId,
		beforeContent,
		afterContent: content,
		isBinary: false,
	});

	return { success: true, path, action: 'edit' };
}
