/**
 * AI Agent Tool Executor.
 * Thin dispatcher that validates input and delegates to individual tool modules.
 */

import fs from 'node:fs/promises';

import { todoItemSchema } from '@shared/validation';

import { TOOL_EXECUTORS } from './tools';
import { isToolName, validateToolInput } from './utilities';

import type { FileChange, SendEventFunction, TodoItem, ToolExecutorContext } from './types';

export type { ToolExecutorContext } from './types';

// =============================================================================
// File System Helpers
// =============================================================================

export async function listFilesRecursive(directory: string, base: string = ''): Promise<string[]> {
	const files: string[] = [];
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (
				entry.name === '.ai-sessions' ||
				entry.name === '.snapshots' ||
				entry.name === '.initialized' ||
				entry.name === '.project-meta.json' ||
				entry.name === '.agent'
			)
				continue;
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

// =============================================================================
// Editing tools blocked in plan mode
// =============================================================================

const EDITING_TOOLS = new Set(['file_edit', 'file_write', 'file_patch', 'file_delete', 'file_move']);

// =============================================================================
// Execute Agent Tool
// =============================================================================

export async function executeAgentTool(
	toolName: string,
	toolInput: Record<string, string>,
	sendEvent: SendEventFunction,
	apiToken: string,
	context: ToolExecutorContext,
	toolUseId?: string,
	queryChanges?: FileChange[],
): Promise<string | object> {
	try {
		let validatedInput: Record<string, string> = toolInput;
		if (isToolName(toolName)) {
			let validation = validateToolInput(toolName, toolInput);
			if (!validation.success) {
				try {
					const repaired = await context.repairToolCall(toolName, toolInput, validation.error, apiToken);
					if (repaired) {
						validation = validateToolInput(toolName, repaired);
					}
				} catch {
					// No-op
				}
				if (!validation.success) {
					return { error: validation.error };
				}
			}
			const data: Record<string, string> = {};
			for (const [key, value] of Object.entries(validation.data)) {
				data[key] = String(value);
			}
			validatedInput = data;
		}

		// Plan/Ask mode defense-in-depth: reject editing tools
		if (context.mode !== 'code' && EDITING_TOOLS.has(toolName)) {
			return { error: 'File editing tools are not available in this mode. Switch to Code mode to make changes.' };
		}

		// Dispatch to the tool module
		const executor = TOOL_EXECUTORS.get(toolName);
		if (!executor) {
			return { error: `Unknown tool: ${toolName}` };
		}

		return await executor(validatedInput, sendEvent, context, toolUseId, queryChanges);
	} catch (error) {
		console.error(`Tool execution error (${toolName}):`, error);
		return { error: String(error) };
	}
}
