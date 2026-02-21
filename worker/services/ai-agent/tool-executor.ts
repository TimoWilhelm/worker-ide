/**
 * AI Agent Tool Executor.
 * Shared helpers used by tool modules: listFilesRecursive, readTodos.
 */

import fs from 'node:fs/promises';

import { HIDDEN_ENTRIES } from '@shared/constants';
import { todoItemSchema } from '@shared/validation';

import type { TodoItem } from './types';

// =============================================================================
// File System Helpers
// =============================================================================

export async function listFilesRecursive(directory: string, base: string = ''): Promise<string[]> {
	const files: string[] = [];
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (HIDDEN_ENTRIES.has(entry.name)) continue;
			const relativePath = base ? `${base}/${entry.name}` : `/${entry.name}`;
			if (entry.isDirectory()) {
				files.push(...(await listFilesRecursive(`${directory}/${entry.name}`, relativePath)));
			} else {
				files.push(relativePath);
			}
		}
	} catch (error) {
		if (base === '') {
			console.error('listFilesRecursive error:', error);
		}
	}
	return files;
}

// =============================================================================
// TODO Management
// =============================================================================

function getTodoFilePath(projectRoot: string, sessionId: string = 'default'): string {
	return `${projectRoot}/.agent/todo/${sessionId}.json`;
}

export async function readTodos(projectRoot: string, sessionId?: string): Promise<TodoItem[]> {
	try {
		const content = await fs.readFile(getTodoFilePath(projectRoot, sessionId), 'utf8');
		const parsed: unknown = JSON.parse(content);
		if (!Array.isArray(parsed)) return [];
		const validated: TodoItem[] = [];
		for (const item of parsed) {
			const result = todoItemSchema.safeParse(item);
			if (result.success) {
				validated.push(result.data);
			}
		}
		return validated;
	} catch {
		return [];
	}
}
