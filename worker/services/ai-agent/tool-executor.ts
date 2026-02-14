/**
 * AI Agent Tool Executor.
 * Handles execution of individual agent tools (file operations, search, TODOs).
 */

import fs from 'node:fs/promises';

import { todoItemSchema } from '@shared/validation';

import { isBinaryFilePath, isToolName, toUint8Array, validateToolInput } from './utilities';
import { isPathSafe, isProtectedFile } from '../../lib/path-utilities';

import type { FileChange, SendEventFunction, TodoItem } from './types';

// =============================================================================
// Tool Executor Context
// =============================================================================

export interface ToolExecutorContext {
	projectRoot: string;
	projectId: string;
	environment: Env;
	planMode: boolean;
	sessionId?: string;
	callMcpTool: (serverId: string, toolName: string, arguments_: Record<string, unknown>) => Promise<string>;
	repairToolCall: (toolName: string, rawInput: unknown, error: string, apiToken: string) => Promise<Record<string, unknown> | undefined>;
}

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

async function writeTodos(todos: TodoItem[], projectRoot: string, sessionId?: string): Promise<void> {
	const filePath = getTodoFilePath(projectRoot, sessionId);
	const directory = filePath.slice(0, filePath.lastIndexOf('/'));
	await fs.mkdir(directory, { recursive: true });
	// eslint-disable-next-line unicorn/no-null -- JSON.stringify requires null as replacer argument
	await fs.writeFile(filePath, JSON.stringify(todos, null, 2));
}

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
	const { projectRoot, projectId, environment, planMode, sessionId } = context;

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

		// Plan mode defense-in-depth: reject editing tools
		if (planMode && ['write_file', 'delete_file', 'move_file'].includes(toolName)) {
			return { error: 'File editing tools are not available in Plan mode. Use read-only tools to research and produce a plan.' };
		}

		switch (toolName) {
			case 'list_files': {
				await sendEvent('status', { message: 'Listing files...' });
				const files = await listFilesRecursive(projectRoot);
				const filtered = files.filter((f) => !f.endsWith('/.initialized') && f !== '/.initialized' && !f.startsWith('/.snapshots/'));
				return { files: filtered };
			}

			case 'read_file': {
				const path = validatedInput.path;
				if (!isPathSafe(projectRoot, path)) {
					return { error: 'Invalid file path' };
				}
				await sendEvent('status', { message: `Reading ${path}...` });
				try {
					const content = await fs.readFile(`${projectRoot}${path}`, 'utf8');
					return { path, content };
				} catch {
					return { error: `File not found: ${path}` };
				}
			}

			case 'write_file': {
				const path = validatedInput.path;
				const content = validatedInput.content;
				if (!isPathSafe(projectRoot, path)) {
					return { error: 'Invalid file path' };
				}
				await sendEvent('status', { message: `Writing ${path}...` });

				const directory = path.slice(0, path.lastIndexOf('/'));
				if (directory) {
					await fs.mkdir(`${projectRoot}${directory}`, { recursive: true });
				}

				const isBinary = isBinaryFilePath(path);
				// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
				let beforeContent: string | Uint8Array | null = null;
				let action: 'create' | 'edit' = 'create';
				try {
					if (isBinary) {
						const buffer = await fs.readFile(`${projectRoot}${path}`);
						beforeContent = toUint8Array(buffer);
					} else {
						beforeContent = await fs.readFile(`${projectRoot}${path}`, 'utf8');
					}
					action = 'edit';
				} catch {
					action = 'create';
				}

				await fs.writeFile(`${projectRoot}${path}`, content);

				if (queryChanges) {
					queryChanges.push({
						path,
						action,
						beforeContent,
						afterContent: content,
						isBinary,
					});
				}

				// Trigger HMR
				const hmrId = environment.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
				const hmrStub = environment.DO_HMR_COORDINATOR.get(hmrId);
				const isCSS = path.endsWith('.css');
				await hmrStub.fetch(
					new Request('http://internal/hmr/trigger', {
						method: 'POST',
						body: JSON.stringify({
							type: isCSS ? 'update' : 'full-reload',
							path,
							timestamp: Date.now(),
							isCSS,
						}),
					}),
				);

				await sendEvent('file_changed', {
					path,
					action,
					tool_use_id: toolUseId,
					// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
					beforeContent: isBinary ? null : beforeContent,
					// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
					afterContent: isBinary ? null : content,
					isBinary,
				});
				return { success: true, path, action };
			}

			case 'delete_file': {
				const path = validatedInput.path;
				if (!isPathSafe(projectRoot, path)) {
					return { error: 'Invalid file path' };
				}
				if (isProtectedFile(path)) {
					return { error: 'Cannot delete worker entry point - this file is required for the application to run' };
				}
				await sendEvent('status', { message: `Deleting ${path}...` });

				const isBinary = isBinaryFilePath(path);
				// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
				let beforeContent: string | Uint8Array | null = null;
				try {
					if (isBinary) {
						const buffer = await fs.readFile(`${projectRoot}${path}`);
						beforeContent = toUint8Array(buffer);
					} else {
						beforeContent = await fs.readFile(`${projectRoot}${path}`, 'utf8');
					}
				} catch {
					// No-op
				}

				try {
					await fs.unlink(`${projectRoot}${path}`);

					if (queryChanges) {
						queryChanges.push({
							path,
							action: 'delete',
							beforeContent,
							// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
							afterContent: null,
							isBinary,
						});
					}

					await sendEvent('file_changed', {
						path,
						action: 'delete',
						tool_use_id: toolUseId,
						// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
						beforeContent: isBinary ? null : beforeContent,
						// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
						afterContent: null,
						isBinary,
					});

					// Trigger HMR so the frontend refreshes the file list
					const hmrId = environment.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
					const hmrStub = environment.DO_HMR_COORDINATOR.get(hmrId);
					await hmrStub.fetch(
						new Request('http://internal/hmr/trigger', {
							method: 'POST',
							body: JSON.stringify({
								type: 'full-reload',
								path,
								timestamp: Date.now(),
							}),
						}),
					);

					return { success: true, path, action: 'delete' };
				} catch {
					return { error: `Failed to delete: ${path}` };
				}
			}

			case 'move_file': {
				const fromPath = validatedInput.from_path;
				const toPath = validatedInput.to_path;
				if (!isPathSafe(projectRoot, fromPath)) {
					return { error: 'Invalid source path' };
				}
				if (!isPathSafe(projectRoot, toPath)) {
					return { error: 'Invalid destination path' };
				}
				if (isProtectedFile(fromPath)) {
					return { error: 'Cannot move protected file - this file is required for the application to run' };
				}
				await sendEvent('status', { message: `Moving ${fromPath} to ${toPath}...` });

				try {
					const isBinaryFrom = isBinaryFilePath(fromPath);
					const isBinaryTo = isBinaryFilePath(toPath);
					let content: string | Uint8Array;
					if (isBinaryFrom) {
						const buffer = await fs.readFile(`${projectRoot}${fromPath}`);
						content = toUint8Array(buffer);
					} else {
						content = await fs.readFile(`${projectRoot}${fromPath}`, 'utf8');
					}

					const destinationDirectory = toPath.slice(0, toPath.lastIndexOf('/'));
					if (destinationDirectory) {
						await fs.mkdir(`${projectRoot}${destinationDirectory}`, { recursive: true });
					}

					await fs.writeFile(`${projectRoot}${toPath}`, content);
					await fs.unlink(`${projectRoot}${fromPath}`);

					if (queryChanges) {
						queryChanges.push(
							{
								path: fromPath,
								action: 'delete',
								beforeContent: content,
								// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
								afterContent: null,
								isBinary: isBinaryFrom,
							},
							{
								path: toPath,
								action: 'create',
								// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
								beforeContent: null,
								afterContent: content,
								isBinary: isBinaryTo,
							},
						);
					}

					await sendEvent('file_changed', {
						path: fromPath,
						action: 'delete',
						tool_use_id: toolUseId,
						// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
						beforeContent: isBinaryFrom ? null : content,
						// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
						afterContent: null,
						isBinary: isBinaryFrom,
					});
					await sendEvent('file_changed', {
						path: toPath,
						action: 'create',
						tool_use_id: toolUseId,
						// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
						beforeContent: null,
						// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
						afterContent: isBinaryTo ? null : content,
						isBinary: isBinaryTo,
					});

					// Trigger HMR for the moved file
					const hmrId = environment.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
					const hmrStub = environment.DO_HMR_COORDINATOR.get(hmrId);
					await hmrStub.fetch(
						new Request('http://internal/hmr/trigger', {
							method: 'POST',
							body: JSON.stringify({
								type: 'full-reload',
								path: toPath,
								timestamp: Date.now(),
							}),
						}),
					);

					return { success: true, from: fromPath, to: toPath };
				} catch (error) {
					return { error: `Failed to move file: ${String(error)}` };
				}
			}

			case 'search_cloudflare_docs': {
				const query = validatedInput.query;
				if (!query) {
					return { error: 'Query is required for search_cloudflare_docs' };
				}
				await sendEvent('status', { message: 'Searching Cloudflare docs...' });
				try {
					const result = await context.callMcpTool('cloudflare-docs', 'search_cloudflare_documentation', { query });
					return { result };
				} catch (error) {
					return { error: `Failed to search Cloudflare docs: ${String(error)}` };
				}
			}

			case 'update_plan': {
				await sendEvent('status', { message: 'Updating plan...' });
				try {
					const planContent = validatedInput.content;
					if (!planContent) {
						return { error: 'Plan content is required' };
					}
					const plansDirectory = `${projectRoot}/.agent/plans`;
					const entries: string[] = await fs.readdir(plansDirectory).catch(() => []);
					const planFiles = entries.filter((entry) => entry.endsWith('-plan.md')).toSorted();
					const latestFile = planFiles.at(-1);
					if (!latestFile) {
						// No existing plan — create a new one
						await fs.mkdir(plansDirectory, { recursive: true });
						const timestamp = Date.now();
						const planFileName = `${timestamp}-plan.md`;
						await fs.writeFile(`${plansDirectory}/${planFileName}`, planContent);
						return { success: true, action: 'created', path: `/.agent/plans/${planFileName}` };
					}
					await fs.writeFile(`${plansDirectory}/${latestFile}`, planContent);
					return { success: true, action: 'updated', path: `/.agent/plans/${latestFile}` };
				} catch (error) {
					return { error: `Failed to update plan: ${String(error)}` };
				}
			}

			case 'get_todos': {
				await sendEvent('status', { message: 'Reading TODOs...' });
				const todos = await readTodos(projectRoot, sessionId);
				return { todos };
			}

			case 'update_todos': {
				await sendEvent('status', { message: 'Updating TODOs...' });
				try {
					// The input may come as a stringified JSON from the model
					let todosRaw: unknown = toolInput.todos;
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

			default: {
				return { error: `Unknown tool: ${toolName}` };
			}
		}
	} catch (error) {
		console.error(`Tool execution error (${toolName}):`, error);
		return { error: String(error) };
	}
}
