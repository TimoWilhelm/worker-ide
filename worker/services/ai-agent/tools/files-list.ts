/**
 * Tool: files_list
 * List all files in the project recursively.
 */

import { listFilesRecursive } from '../tool-executor';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const DESCRIPTION = `List all files in the project recursively. Returns a flat array of all file paths in the project tree.

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

	await sendEvent('status', { message: 'Listing files...' });
	const files = await listFilesRecursive(projectRoot);
	const filtered = files.filter((f) => !f.endsWith('/.initialized') && f !== '/.initialized');
	return { title: 'project files', metadata: { count: filtered.length }, output: filtered.join('\n') };
}
