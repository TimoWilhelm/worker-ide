/**
 * Tool registry — wraps individual tool modules into TanStack AI toolDefinition().server() format.
 *
 * Individual tool files export { definition, execute }.
 * This barrel wraps them into TanStack AI tools using factories that capture runtime context.
 */

import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';

import { ToolExecutionError } from '@shared/tool-errors';

import * as cdpEvalTool from './cdp-eval';
import * as dependenciesListTool from './dependencies-list';
import * as dependenciesUpdateTool from './dependencies-update';
import * as documentationSearchTool from './documentation-search';
import * as fileDeleteTool from './file-delete';
import * as fileEditTool from './file-edit';
import * as fileGlobTool from './file-glob';
import * as fileGrepTool from './file-grep';
import * as fileListTool from './file-list';
import * as fileMoveTool from './file-move';
import * as fileMultieditTool from './file-multiedit';
import * as fileReadTool from './file-read';
import * as fileWriteTool from './file-write';
import * as filesListTool from './files-list';
import * as lintCheckTool from './lint-check';
import * as lintFixTool from './lint-fix';
import * as planUpdateTool from './plan-update';
import * as testRunTool from './test-run';
import * as todosGetTool from './todos-get';
import * as todosUpdateTool from './todos-update';
import * as userQuestionTool from './user-question';
import * as webFetchTool from './web-fetch';
import { sanitizeToolInput, summarizeToolResult } from '../agent-logger';
import { isRecordObject } from '../utilities';

import type { AgentLogger } from '../agent-logger';
import type {
	CustomEventQueue,
	FileChange,
	SendEventFunction,
	ToolDefinition,
	ToolExecuteFunction,
	ToolExecutorContext,
	ToolFailureQueue,
} from '../types';

// =============================================================================
// Tool executor dispatch map
// =============================================================================

export const TOOL_EXECUTORS: ReadonlyMap<string, ToolExecuteFunction> = new Map([
	['file_edit', fileEditTool.execute],
	['file_multiedit', fileMultieditTool.execute],
	['file_write', fileWriteTool.execute],
	['file_read', fileReadTool.execute],
	['file_grep', fileGrepTool.execute],
	['file_glob', fileGlobTool.execute],
	['file_list', fileListTool.execute],
	['files_list', filesListTool.execute],

	['file_delete', fileDeleteTool.execute],
	['file_move', fileMoveTool.execute],
	['user_question', userQuestionTool.execute],
	['web_fetch', webFetchTool.execute],
	['docs_search', documentationSearchTool.execute],
	['plan_update', planUpdateTool.execute],
	['todos_get', todosGetTool.execute],
	['todos_update', todosUpdateTool.execute],
	['dependencies_list', dependenciesListTool.execute],
	['dependencies_update', dependenciesUpdateTool.execute],
	['lint_check', lintCheckTool.execute],
	['lint_fix', lintFixTool.execute],
	['cdp_eval', cdpEvalTool.execute],
	['test_run', testRunTool.execute],
]);

// =============================================================================
// Tool definitions
// =============================================================================

export const AGENT_TOOLS: readonly ToolDefinition[] = [
	fileEditTool.definition,
	fileMultieditTool.definition,
	fileWriteTool.definition,
	fileReadTool.definition,
	fileGrepTool.definition,
	fileGlobTool.definition,
	fileListTool.definition,
	filesListTool.definition,

	fileDeleteTool.definition,
	fileMoveTool.definition,
	userQuestionTool.definition,
	webFetchTool.definition,
	documentationSearchTool.definition,
	planUpdateTool.definition,
	todosGetTool.definition,
	todosUpdateTool.definition,
	dependenciesListTool.definition,
	dependenciesUpdateTool.definition,
	lintCheckTool.definition,
	lintFixTool.definition,
	cdpEvalTool.definition,
	testRunTool.definition,
];

// =============================================================================
// Plan mode tools (read-only subset)
// =============================================================================

const PLAN_MODE_TOOL_NAMES = new Set([
	'file_read',
	'file_grep',
	'file_glob',
	'file_list',
	'files_list',
	'user_question',
	'web_fetch',
	'docs_search',
	'plan_update',
	'todos_get',
	'todos_update',
	'dependencies_list',
	'lint_check',
	'cdp_eval',
	'test_run',
]);

export const PLAN_MODE_TOOLS: readonly ToolDefinition[] = AGENT_TOOLS.filter((tool) => PLAN_MODE_TOOL_NAMES.has(tool.name));

// =============================================================================
// Ask mode tools (no tools — conversational only)
// =============================================================================

export const ASK_MODE_TOOLS: readonly ToolDefinition[] = [];

// =============================================================================
// Editing tools blocked in plan mode
// =============================================================================

const EDITING_TOOL_NAMES = new Set(['file_edit', 'file_multiedit', 'file_write', 'file_delete', 'file_move', 'lint_fix']);

/**
 * Read-only tools that can be batched freely within a single iteration.
 * These have no side effects and are safe to execute in parallel.
 */
export const READ_ONLY_TOOL_NAMES = new Set([
	'file_read',
	'file_grep',
	'file_glob',
	'file_list',
	'files_list',
	'docs_search',
	'todos_get',
	'dependencies_list',
	'lint_check',
	'cdp_eval',
	'test_run',
]);

/**
 * Mutation tool names — tools that modify files or project state.
 * Used by the doom loop detector and logging to track mutation activity.
 */
export const MUTATION_TOOL_NAMES = new Set([
	'file_edit',
	'file_multiedit',
	'file_write',
	'file_delete',
	'file_move',
	'lint_fix',
	'dependencies_update',
]);

// =============================================================================
// TanStack AI Tool Factory
// =============================================================================

/**
 * Convert a JSON Schema `properties` object into a Zod z.object() schema.
 * This is a shallow conversion — handles string, number, boolean, array, and enum types.
 * Used to bridge tool definitions into TanStack AI toolDefinition() format.
 */
function jsonSchemaToZod(properties: Record<string, unknown>, required: string[] = []): z.ZodObject<Record<string, z.ZodTypeAny>> {
	const requiredSet = new Set(required);
	const shape: Record<string, z.ZodTypeAny> = {};

	for (const [key, value] of Object.entries(properties)) {
		if (!isRecordObject(value)) continue;

		const property = value;
		let schema: z.ZodTypeAny;

		// Handle enum type
		if (Array.isArray(property.enum) && property.enum.length > 0) {
			const enumValues = property.enum.filter((v): v is string => typeof v === 'string');
			const [first, ...rest] = enumValues;
			schema = first === undefined ? z.string() : z.enum([first, ...rest]);
		} else {
			switch (property.type) {
				case 'number':
				case 'integer': {
					schema = z.number();
					break;
				}
				case 'boolean': {
					schema = z.boolean();
					break;
				}
				case 'array': {
					schema = z.array(z.unknown());
					break;
				}
				default: {
					schema = z.string();
					break;
				}
			}
		}

		// Add description if present
		if (typeof property.description === 'string') {
			schema = schema.describe(property.description);
		}

		// Make optional if not required
		if (!requiredSet.has(key)) {
			schema = schema.optional();
		}

		shape[key] = schema;
	}

	return z.object(shape);
}

/**
 * Create a SendEventFunction that pushes CUSTOM AG-UI events into the shared queue.
 * Tools call `sendEvent('file_changed', { path, action, ... })` and it becomes
 * a `{ type: 'CUSTOM', name: 'file_changed', data: { path, action, ... }, timestamp }` event.
 */
export function createSendEvent(eventQueue: CustomEventQueue): SendEventFunction {
	return (type: string, data: Record<string, unknown>) => {
		eventQueue.push({
			type: 'CUSTOM',
			name: type,
			data,
			timestamp: Date.now(),
		});
	};
}

/**
 * Create TanStack AI server tools from our tool modules.
 *
 * Each tool's execute function is wrapped in a closure that captures:
 * - sendEvent: callback to push CUSTOM AG-UI events to the event queue
 * - context: project root, mode, session ID, MCP client
 * - queryChanges: mutable array for tracking file changes (for snapshots)
 *
 * @param sendEvent - Function to push CUSTOM events to the event queue
 * @param context - Tool executor context (project root, mode, etc.)
 * @param queryChanges - Mutable array for tracking file changes
 * @param mode - Agent mode (code, plan, ask) — determines which tools are available
 * @param logger - Optional debug logger for structured tool call logging
 */
export function createServerTools(
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges: FileChange[],
	mode: 'code' | 'plan' | 'ask',
	logger?: AgentLogger,
	toolFailures?: ToolFailureQueue,
) {
	// Select which tool definitions to use based on mode
	const activeToolDefinitions = mode === 'ask' ? ASK_MODE_TOOLS : mode === 'plan' ? PLAN_MODE_TOOLS : AGENT_TOOLS;

	return activeToolDefinitions.map((definition) => {
		const executor = TOOL_EXECUTORS.get(definition.name);
		if (!executor) {
			throw new Error(`No executor found for tool: ${definition.name}`);
		}

		const inputSchema = jsonSchemaToZod(definition.input_schema.properties, definition.input_schema.required);

		return toolDefinition({
			name: definition.name,
			description: definition.description,
			inputSchema,
		}).server(async (input) => {
			// Defense-in-depth: reject editing tools in non-code modes
			if (mode !== 'code' && EDITING_TOOL_NAMES.has(definition.name)) {
				logger?.warn('tool_call', 'blocked', {
					toolName: definition.name,
					reason: 'editing_tool_in_non_code_mode',
					mode,
				});
				// Return a JSON object — @tanstack/ai's executeToolCalls() calls
				// JSON.parse() on string results, so plain strings would throw.
				return { content: 'File editing tools are not available in this mode. Switch to Code mode to make changes.' };
			}

			// Coerce input values to strings (tool executors expect Record<string, string>)
			const stringInput: Record<string, string> = {};
			for (const [key, value] of Object.entries(input)) {
				stringInput[key] = String(value);
			}

			logger?.info('tool_call', 'started', {
				toolName: definition.name,
				input: sanitizeToolInput(stringInput),
			});
			const timer = logger?.startTimer();

			try {
				const result = await executor(stringInput, sendEvent, context, queryChanges);

				logger?.info(
					'tool_call',
					'completed',
					{
						toolName: definition.name,
						resultSummary: summarizeToolResult(result.output),
						resultLength: result.output.length,
					},
					{ durationMs: timer?.() },
				);

				// Emit structured metadata as a CUSTOM event for the UI.
				// The tool call ID is injected by service.ts when it drains the event queue.
				sendEvent('tool_result', {
					tool_name: definition.name,
					title: result.title,
					metadata: result.metadata,
				});

				// Send only the text output to the LLM
				return { content: result.output };
			} catch (error) {
				// ToolExecutionError = expected tool-level failure (file not found, no match, etc.)
				// Other errors = unexpected crashes in tool code
				const isToolError = error instanceof ToolExecutionError;
				const logMethod = isToolError ? 'warn' : 'error';
				const event = isToolError ? 'tool_error' : 'error';
				logger?.[logMethod](
					'tool_call',
					event,
					{
						toolName: definition.name,
						errorCode: isToolError ? error.code : undefined,
						error: error instanceof Error ? error.message : String(error),
						stack: isToolError ? undefined : error instanceof Error ? error.stack : undefined,
					},
					{ durationMs: timer?.() },
				);

				// Push typed failure record for doom-loop detection and frontend error display
				toolFailures?.push({
					toolName: definition.name,
					errorCode: isToolError ? error.code : undefined,
					errorMessage: error instanceof Error ? error.message : String(error),
				});

				throw error;
			}
		});
	});
}
