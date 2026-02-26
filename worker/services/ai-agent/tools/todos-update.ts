/**
 * Tool: todos_update
 * Create or update the TODO list for the session.
 */

import fs from 'node:fs/promises';

import { ToolExecutionError } from '@shared/tool-errors';
import { todoItemSchema } from '@shared/validation';

import type { SendEventFunction, TodoItem, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const DESCRIPTION = `Create or update the TODO list for this session. Use this to track progress, organize complex tasks, and help the user understand overall progress. Provide the full list of TODO items. Each item must have id, content, status (pending/in_progress/completed), and priority (high/medium/low).

When to use:
- Complex multistep tasks that require 3 or more distinct steps.
- When the user provides multiple tasks or a list of things to be done.
- After receiving new instructions — immediately capture requirements as todos.
- After completing a task — mark it complete and add any follow-up tasks.

When NOT to use:
- There is only a single, straightforward task.
- The task is trivial and can be completed in fewer than 3 steps.
- The task is purely conversational or informational.

Task management:
- Provide the complete list of TODO items (not just changes).
- Only have ONE task as in_progress at a time. Complete existing tasks before starting new ones.
- Mark tasks as completed IMMEDIATELY after finishing — do not batch completions.
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
): Promise<ToolResult> {
	const { projectRoot, sessionId } = context;

	sendEvent('status', { message: 'Updating TODOs...' });

	try {
		let todosRaw: unknown = input.todos;
		if (typeof todosRaw === 'string') {
			try {
				todosRaw = JSON.parse(todosRaw);
			} catch {
				throw new ToolExecutionError('MISSING_INPUT', 'Invalid JSON for todos field');
			}
		}
		if (!Array.isArray(todosRaw)) {
			throw new ToolExecutionError('MISSING_INPUT', 'todos must be an array');
		}

		const validated: TodoItem[] = [];
		for (const item of todosRaw) {
			const parsed = todoItemSchema.safeParse(item);
			if (!parsed.success) {
				throw new ToolExecutionError('MISSING_INPUT', `Invalid TODO item: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`);
			}
			validated.push(parsed.data);
		}

		await writeTodos(validated, projectRoot, sessionId);
		return { title: 'todos', metadata: { todos: validated }, output: `Updated ${validated.length} TODO(s).` };
	} catch (error) {
		if (error instanceof ToolExecutionError) {
			throw error;
		}
		throw new ToolExecutionError('MISSING_INPUT', `Failed to update TODOs: ${String(error)}`);
	}
}
