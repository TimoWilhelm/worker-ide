/**
 * Tool: todos_update
 * Create or update the TODO list for the session.
 */

import fs from 'node:fs/promises';

import { todoItemSchema } from '@shared/validation';

import type { SendEventFunction, TodoItem, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Create or update the TODO list for this session. Provide the full list of TODO items. Each item must have id, content, status (pending/in_progress/completed), and priority (high/medium/low).

Usage:
- Provide the complete list of TODO items (not just changes).
- Mark items as in_progress when you start working on them.
- Mark items as completed when done.
- Use high priority for blocking tasks, medium for normal, low for nice-to-have.`;

export const definition: ToolDefinition = {
	name: 'todos_update',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			todos: {
				type: 'array',
				description: 'The full list of TODO items',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Unique identifier for the TODO item' },
						content: { type: 'string', description: 'Description of the task' },
						status: {
							type: 'string',
							enum: ['pending', 'in_progress', 'completed'],
							description: 'Current status of the task',
						},
						priority: {
							type: 'string',
							enum: ['high', 'medium', 'low'],
							description: 'Priority level of the task',
						},
					},
					required: ['id', 'content', 'status', 'priority'],
				},
			},
		},
		required: ['todos'],
	},
};

function getTodoFilePath(projectRoot: string, sessionId: string = 'default'): string {
	return `${projectRoot}/.agent/todo/${sessionId}.json`;
}

async function writeTodos(todos: TodoItem[], projectRoot: string, sessionId?: string): Promise<void> {
	const filePath = getTodoFilePath(projectRoot, sessionId);
	const directory = filePath.slice(0, filePath.lastIndexOf('/'));
	await fs.mkdir(directory, { recursive: true });
	// eslint-disable-next-line unicorn/no-null -- JSON.stringify requires null as replacer argument
	await fs.writeFile(filePath, JSON.stringify(todos, null, 2));
}

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<string | object> {
	const { projectRoot, sessionId } = context;

	await sendEvent('status', { message: 'Updating TODOs...' });

	try {
		let todosRaw: unknown = input.todos;
		if (typeof todosRaw === 'string') {
			try {
				todosRaw = JSON.parse(todosRaw);
			} catch {
				return { error: 'Invalid JSON for todos field' };
			}
		}
		if (!Array.isArray(todosRaw)) {
			return { error: 'todos must be an array' };
		}

		const validated: TodoItem[] = [];
		for (const item of todosRaw) {
			const parsed = todoItemSchema.safeParse(item);
			if (!parsed.success) {
				return { error: `Invalid TODO item: ${parsed.error.issues.map((issue) => issue.message).join(', ')}` };
			}
			validated.push(parsed.data);
		}

		await writeTodos(validated, projectRoot, sessionId);
		return { success: true, count: validated.length, todos: validated };
	} catch (error) {
		return { error: `Failed to update TODOs: ${String(error)}` };
	}
}
