/**
 * Tool: files_list
 * List all files in the project recursively.
 */

import { listFilesRecursive } from '../tool-executor';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `List all files in the project recursively. Returns a flat array of file paths.

Usage:
- Returns every file in the project tree.
- Hidden system directories (.ai-sessions, .snapshots, .agent) are excluded automatically.
- For listing a single directory with sizes, use file_list instead.`;

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
): Promise<string | object> {
	const { projectRoot } = context;

	await sendEvent('status', { message: 'Listing files...' });
	const files = await listFilesRecursive(projectRoot);
	const filtered = files.filter((f) => !f.endsWith('/.initialized') && f !== '/.initialized' && !f.startsWith('/.snapshots/'));
	return { files: filtered };
}
