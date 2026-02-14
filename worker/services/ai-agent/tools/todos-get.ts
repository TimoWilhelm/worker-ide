/**
 * Tool: todos_get
 * Get the current TODO list for the session.
 */

import { readTodos } from '../tool-executor';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Get the current TODO list for this session. Returns an array of TODO items with id, content, status (pending/in_progress/completed), and priority (high/medium/low).

Usage:
- Call this to check your current task list before starting work.
- Use update_todos to modify the list.`;

export const definition: ToolDefinition = {
	name: 'todos_get',
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
	const { projectRoot, sessionId } = context;

	await sendEvent('status', { message: 'Reading TODOs...' });
	const todos = await readTodos(projectRoot, sessionId);
	return { todos };
}
