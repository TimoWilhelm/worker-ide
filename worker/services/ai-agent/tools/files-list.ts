/**
 * Tool: files_list
 * List all files in the project recursively.
 */

import { listFilesRecursive } from '../tool-executor';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

/** Maximum number of file paths returned to the LLM. */
const MAX_FILES = 200;

const DESCRIPTION = `List all files in the project recursively. Returns a flat array of all file paths in the project tree.

Usage:
- Returns every file in the project tree as a flat list.
- Hidden system directories (.agent) are excluded automatically.
- Use this to get a complete overview of the project structure.
- For listing a single directory with sizes, use the file_list tool instead.`;

export const definition: ToolDefinition = {
	name: 'files_list',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {},
	},
};

export async function execute(
	_input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const { projectRoot } = context;

	sendEvent('status', { message: 'Listing files...' });
	const files = await listFilesRecursive(projectRoot);
	const filtered = files.filter((f) => !f.endsWith('/.initialized') && f !== '/.initialized');

	const truncated = filtered.length > MAX_FILES;
	const displayFiles = truncated ? filtered.slice(0, MAX_FILES) : filtered;
	const output = truncated
		? displayFiles.join('\n') +
			`\n\n(Showing first ${MAX_FILES} of ${filtered.length} files. Use file_grep or file_glob to find specific files.)`
		: displayFiles.join('\n');

	return { title: 'project files', metadata: { count: filtered.length, truncated }, output };
}
