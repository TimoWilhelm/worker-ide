/**
 * Tool: file_edit
 * Modify existing files using exact string replacements.
 */

import fs from 'node:fs/promises';

import { isPathSafe } from '../../../lib/path-utilities';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Modify an existing file using exact string replacement. Finds old_string in the file and replaces it with new_string. Fails if old_string is not found or matches multiple times (unless replace_all is "true"). Prefer this over write for targeted changes.

Usage:
- Always read the file first before editing to understand the existing code structure.
- Preserve exact indentation (tabs/spaces) as it appears in the file.
- The edit will FAIL if old_string is not found in the file.
- The edit will FAIL if old_string matches multiple times (unless replace_all is "true").
- Use replace_all for renaming variables or replacing repeated strings across the file.
- Prefer edit over write for modifying existing files — it produces smaller, less error-prone changes.`;

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
	await coordinatorStub.fetch(
		new Request('http://internal/ws/trigger', {
			method: 'POST',
			body: JSON.stringify({ type: isCSS ? 'update' : 'full-reload', path, timestamp: Date.now(), isCSS }),
		}),
	);

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
