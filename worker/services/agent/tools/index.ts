import { createWorkspaceStateBackend } from '@cloudflare/shell';
import { jsonSchema } from 'ai';
import { env } from 'cloudflare:workers';

import { ToolExecutionError } from '@shared/tool-errors';
import { createHmrUpdateForFile } from '@shared/types';
import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';
import { isHiddenPath } from '@worker/lib/path-utilities';
import { fs } from '@worker/lib/project-fs';
import { PROJECT_ROOT, WorkspaceClient } from '@worker/lib/workspace-client';

import * as assetSettingsGetTool from './asset-settings-get';
import * as assetSettingsUpdateTool from './asset-settings-update';
import * as bashTool from './bash';
import * as bindingsGetTool from './bindings-get';
import * as bindingsUpdateTool from './bindings-update';
import * as dependenciesListTool from './dependencies-list';
import * as dependenciesUpdateTool from './dependencies-update';
import * as documentationSearchTool from './documentation-search';
import * as imageGenerateTool from './image-generate';
import * as lintCheckTool from './lint-check';
import * as lintFixTool from './lint-fix';
import { buildAllowedPreviewOrigins } from './network-policy';
import * as planUpdateTool from './plan-update';
import * as previewFetchTool from './preview-fetch';
import * as subAgentTool from './sub-agent';
import * as testRunTool from './test-run';
import * as todosGetTool from './todos-get';
import * as todosUpdateTool from './todos-update';
import * as userQuestionTool from './user-question';
import * as webFetchTool from './web-fetch';
import { DEV_PREVIEW_SECRET } from '../../../lib/preview-secret';
import { sanitizeToolInput, summarizeToolResult } from '../agent-logger';

import type { AgentLogger } from '../agent-logger';
import type {
	FileChange,
	PendingToolCallIds,
	SendEventFunction,
	ToolCallIdReference,
	ToolDefinition,
	ToolExecuteFunction,
	ToolExecutorContext,
	ToolFailureQueue,
} from '../types';
import type { StateBackend, WorkspaceChangeEvent } from '@cloudflare/shell';

export const TOOL_EXECUTORS: ReadonlyMap<string, ToolExecuteFunction> = new Map([
	['user_question', userQuestionTool.execute],
	['web_fetch', webFetchTool.execute],
	['docs_search', documentationSearchTool.execute],
	['plan_update', planUpdateTool.execute],
	['todos_get', todosGetTool.execute],
	['todos_update', todosUpdateTool.execute],
	['dependencies_list', dependenciesListTool.execute],
	['dependencies_update', dependenciesUpdateTool.execute],
	['asset_settings_get', assetSettingsGetTool.execute],
	['asset_settings_update', assetSettingsUpdateTool.execute],
	['bindings_get', bindingsGetTool.execute],
	['bindings_update', bindingsUpdateTool.execute],
	['lint_check', lintCheckTool.execute],
	['lint_fix', lintFixTool.execute],
	['preview_fetch', previewFetchTool.execute],
	['test_run', testRunTool.execute],
	['image_generate', imageGenerateTool.execute],
	['sub_agent', subAgentTool.execute],
	['bash', bashTool.execute],
]);

export const AGENT_TOOLS: readonly ToolDefinition[] = [
	userQuestionTool.definition,
	webFetchTool.definition,
	documentationSearchTool.definition,
	planUpdateTool.definition,
	todosGetTool.definition,
	todosUpdateTool.definition,
	dependenciesListTool.definition,
	dependenciesUpdateTool.definition,
	assetSettingsGetTool.definition,
	assetSettingsUpdateTool.definition,
	bindingsGetTool.definition,
	bindingsUpdateTool.definition,
	lintCheckTool.definition,
	lintFixTool.definition,
	previewFetchTool.definition,
	testRunTool.definition,
	imageGenerateTool.definition,
	subAgentTool.definition,
	bashTool.definition,
];

const DEFINITIONS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(AGENT_TOOLS.map((definition) => [definition.name, definition]));

/**
 * Tools the model calls directly (outside Code Mode): they pause for user
 * input or drive durable UI panels, so they cannot run inside the sandbox.
 */
const DIRECT_TOOL_NAMES = new Set(['user_question', 'plan_update', 'todos_get', 'todos_update']);

const PLAN_MODE_TOOL_NAMES = new Set([
	'user_question',
	'web_fetch',
	'docs_search',
	'plan_update',
	'todos_get',
	'todos_update',
	'dependencies_list',
	'asset_settings_get',
	'bindings_get',
	'lint_check',
	'preview_fetch',
	'test_run',
]);

export const PLAN_MODE_TOOLS: readonly ToolDefinition[] = AGENT_TOOLS.filter((t) => PLAN_MODE_TOOL_NAMES.has(t.name));

const ASK_MODE_TOOL_NAMES = new Set([
	'user_question',
	'web_fetch',
	'docs_search',
	'dependencies_list',
	'asset_settings_get',
	'bindings_get',
	'lint_check',
	'preview_fetch',
	'test_run',
]);

export const ASK_MODE_TOOLS: readonly ToolDefinition[] = AGENT_TOOLS.filter((t) => ASK_MODE_TOOL_NAMES.has(t.name));

const EDITING_TOOL_NAMES = new Set(['lint_fix', 'image_generate', 'bash']);

/**
 * Read-only tools that can be batched freely within a single iteration.
 * These have no side effects and are safe to execute in parallel.
 */
export const READ_ONLY_TOOL_NAMES = new Set([
	'docs_search',
	'todos_get',
	'dependencies_list',
	'asset_settings_get',
	'bindings_get',
	'lint_check',
	'preview_fetch',
	'test_run',
]);

/**
 * Tools excluded from sub-agent runs.
 * - sub_agent: prevents recursive spawning
 * - user_question: sub-agents cannot interact with the user
 * - plan/todos tools: sub-agents are ephemeral and should report back to the
 *   root agent instead of creating durable task state of their own
 */
export const SUB_AGENT_EXCLUDED_TOOLS = new Set(['sub_agent', 'user_question', 'plan_update', 'todos_get', 'todos_update']);

/**
 * Mutation tool names — tools that modify files or project state.
 * Used by the doom loop detector and logging to track mutation activity.
 */
export const MUTATION_TOOL_NAMES = new Set([
	'lint_fix',
	'dependencies_update',
	'asset_settings_update',
	'bindings_update',
	'image_generate',
	'bash',
]);

/**
 * `state.*` methods that mutate the workspace. In plan/ask mode the state
 * backend is wrapped to reject these so Code Mode stays read-only.
 */
const STATE_WRITE_METHODS = new Set([
	'writeFile',
	'writeFileBytes',
	'appendFile',
	'writeJson',
	'updateJson',
	'mkdir',
	'rm',
	'cp',
	'mv',
	'symlink',
	'replaceInFile',
	'replaceInFiles',
	'applyEdits',
	'applyEditPlan',
	'createArchive',
	'extractArchive',
	'compressFile',
	'decompressFile',
	'removeTree',
	'copyTree',
	'moveTree',
]);

type AnyTool = Record<string, unknown>;

/**
 * Assemble the model-facing tool surface: a single `codemode` tool exposing
 * domain tools as `tools.*`, the workspace filesystem as `state.*`, and the
 * browser as `tools.browser_*`, plus the interactive tools that must stay direct
 * (they pause for input or drive UI panels). Without isolate bindings (tests,
 * sub-agents) every tool is exposed directly instead.
 */
export async function createServerTools(
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges: FileChange[],
	mode: 'code' | 'plan' | 'ask',
	logger?: AgentLogger,
	toolFailures?: ToolFailureQueue,
	_toolCallIdReference?: ToolCallIdReference,
	_pendingToolCallIds?: PendingToolCallIds,
	excludedToolNames?: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
	// Paths whose file_changed event a tool already emitted, so the Code Mode
	// drain can skip re-emitting them after a sandbox run.
	const emittedChangePaths = new Set<string>();
	const trackedSendEvent: SendEventFunction = (type, data) => {
		if (type === 'file_changed' && typeof data.path === 'string') {
			emittedChangePaths.add(data.path);
		}
		sendEvent(type, data);
	};

	const isExcluded = (name: string): boolean => Boolean(excludedToolNames?.has(name));
	const wrapDeps = (events: SendEventFunction): WrapDeps => ({ sendEvent: events, context, queryChanges, mode, logger, toolFailures });

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool generic variance; streamText/createExecuteRuntime accept ToolSet (Record<string, Tool<any, any>>)
	const llmTools: Record<string, any> = {};

	// 1. Direct interactive tools.
	for (const name of directToolNames(mode)) {
		if (isExcluded(name)) continue;
		const definition = DEFINITIONS_BY_NAME.get(name);
		const executor = TOOL_EXECUTORS.get(name);
		if (definition && executor) {
			llmTools[name] = wrapTool(definition, executor, wrapDeps(sendEvent));
		}
	}

	// 2. Code Mode `tools.*` — domain tools, MCP tools, extension tools, browser tools.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool generic variance; createExecuteRuntime accepts ToolSet (Record<string, Tool<any, any>>)
	const codeModeTools: Record<string, any> = {};
	for (const name of codeModeToolNames(mode)) {
		if (isExcluded(name)) continue;
		const definition = DEFINITIONS_BY_NAME.get(name);
		const executor = TOOL_EXECUTORS.get(name);
		if (definition && executor) {
			codeModeTools[name] = wrapTool(definition, executor, wrapDeps(trackedSendEvent));
		}
	}

	if (context.session) {
		Object.assign(codeModeTools, await context.session.tools());
	}

	if (context.extensionManager) {
		const { createExtensionTools } = await import('@cloudflare/think/tools/extensions');
		Object.assign(codeModeTools, createExtensionTools({ manager: context.extensionManager }));
		Object.assign(codeModeTools, context.extensionManager.getTools());
	}

	await addBrowserTools(codeModeTools, context, mode);

	// 3. Assemble the single Code Mode tool — or fall back to direct exposure.
	if (context.ctx && context.loader) {
		const { createExecuteRuntime } = await import('@cloudflare/think/tools/execute');
		const { tool } = createExecuteRuntime({
			ctx: context.ctx,
			tools: codeModeTools,
			state: createStateBackend(context, mode),
			loader: context.loader,
			// eslint-disable-next-line unicorn/no-null -- codemode uses null to fully disable sandbox outbound network access
			globalOutbound: null,
		});
		llmTools.codemode = wrapCodemodeTool(tool, context, trackedSendEvent, queryChanges, emittedChangePaths);
	} else {
		Object.assign(llmTools, codeModeTools);
	}

	return llmTools;
}

interface WrapDeps {
	sendEvent: SendEventFunction;
	context: ToolExecutorContext;
	queryChanges: FileChange[];
	mode: 'code' | 'plan' | 'ask';
	logger?: AgentLogger;
	toolFailures?: ToolFailureQueue;
}

/** Names of the direct (non-Code-Mode) tools available in a given mode. */
function directToolNames(mode: 'code' | 'plan' | 'ask'): string[] {
	if (mode === 'ask') return [...DIRECT_TOOL_NAMES].filter((name) => ASK_MODE_TOOL_NAMES.has(name));
	if (mode === 'plan') return [...DIRECT_TOOL_NAMES].filter((name) => PLAN_MODE_TOOL_NAMES.has(name));
	return [...DIRECT_TOOL_NAMES];
}

/** Names of the tools exposed inside Code Mode as `tools.*` for a given mode. */
function codeModeToolNames(mode: 'code' | 'plan' | 'ask'): string[] {
	const base = mode === 'ask' ? ASK_MODE_TOOL_NAMES : mode === 'plan' ? PLAN_MODE_TOOL_NAMES : new Set(AGENT_TOOLS.map((t) => t.name));
	return [...base].filter((name) => !DIRECT_TOOL_NAMES.has(name));
}

/** Build the `state.*` backend, read-only in plan/ask mode. */
function createStateBackend(context: ToolExecutorContext, mode: 'code' | 'plan' | 'ask'): StateBackend {
	const backend = createWorkspaceStateBackend(new WorkspaceClient(context.fsStub, PROJECT_ROOT));
	if (mode === 'code') return backend;
	return new Proxy(backend, {
		get(target, property, receiver) {
			if (typeof property === 'string' && STATE_WRITE_METHODS.has(property)) {
				return () => {
					throw new ToolExecutionError(
						'NOT_ALLOWED',
						`state.${property} is read-only in ${mode} mode. Switch to Code mode to make changes.`,
					);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

/**
 * After each sandbox run, reflect workspace writes made via `state.*`/`bash`
 * back to the UI (file-change events, preview HMR, snapshots). Writes already
 * surfaced by a `tools.*` call are skipped.
 */
function wrapCodemodeTool(
	tool: AnyTool,
	context: ToolExecutorContext,
	sendEvent: SendEventFunction,
	queryChanges: FileChange[],
	emittedChangePaths: ReadonlySet<string>,
): AnyTool {
	const originalExecute = tool.execute;
	if (typeof originalExecute !== 'function') return tool;
	return {
		...tool,
		execute: async (input: unknown, options: unknown) => {
			try {
				return await Reflect.apply(originalExecute, tool, [input, options]);
			} finally {
				await drainWorkspaceChanges(context, sendEvent, queryChanges, emittedChangePaths);
			}
		},
	};
}

async function drainWorkspaceChanges(
	context: ToolExecutorContext,
	sendEvent: SendEventFunction,
	queryChanges: FileChange[],
	emittedChangePaths: ReadonlySet<string>,
): Promise<void> {
	const changes: WorkspaceChangeEvent[] = await context.fsStub.drainWorkspaceChanges();
	const seen = new Set<string>();
	const hmrPaths: string[] = [];

	for (const change of changes) {
		const path = change.path;
		if (seen.has(path) || emittedChangePaths.has(path)) continue;
		if (path.startsWith('/.git') || isHiddenPath(path)) continue;
		seen.add(path);

		const action = change.type === 'create' ? 'create' : change.type === 'delete' ? 'delete' : 'edit';
		let afterContent: string | undefined;
		if (action !== 'delete') {
			try {
				afterContent = await fs.readFile(`${PROJECT_ROOT}${path}`, 'utf8');
			} catch {
				afterContent = undefined;
			}
		}

		sendEvent('file_changed', { path, action, afterContent });
		queryChanges.push({ path, action, beforeContent: undefined, afterContent, isBinary: false });
		hmrPaths.push(path);
	}

	if (hmrPaths.length > 0) {
		const coordinator = coordinatorNamespace.getByName(`project:${context.projectId}`);
		await Promise.all(hmrPaths.map((path) => coordinator.triggerUpdate(createHmrUpdateForFile(path))));
	}
}

/**
 * Convert a {@link ToolDefinition} + executor into an AI SDK tool: validate and
 * string-coerce input, enforce mode gating, log, emit `tool_result`, and feed
 * the doom-loop failure queue.
 */
function wrapTool(definition: ToolDefinition, executor: ToolExecuteFunction, deps: WrapDeps): AnyTool {
	const { sendEvent, context, queryChanges, mode, logger, toolFailures } = deps;
	const toolName = definition.name;

	const requiredProperties = new Set<string>(Array.isArray(definition.input_schema.required) ? definition.input_schema.required : []);
	const knownProperties = new Set<string>(definition.input_schema.properties ? Object.keys(definition.input_schema.properties) : []);

	// A `validate` function is required so the AI SDK runs input validation
	// (and `experimental_repairToolCall` fires) for hallucinated property names.
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- Bridge between our JSON Schema definitions and the AI SDK's JSONSchema7 type
	const schema = jsonSchema<Record<string, string>>(definition.input_schema as any, {
		validate: (value): { success: true; value: Record<string, string> } | { success: false; error: Error } => {
			if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
				return { success: false, error: new Error('Expected an object') };
			}
			const entries = Object.entries(value);
			const keys = entries.map(([key]) => key);
			for (const required of requiredProperties) {
				if (!keys.includes(required)) {
					return { success: false, error: new Error(`Missing required property: "${required}". Received keys: ${keys.join(', ')}`) };
				}
			}
			// Strip unknown properties and string-coerce values (objects/arrays are
			// JSON-serialized so structured data survives).
			const validated: Record<string, string> = {};
			for (const [key, entryValue] of entries) {
				if (knownProperties.has(key)) {
					validated[key] = typeof entryValue === 'object' && entryValue !== null ? JSON.stringify(entryValue) : String(entryValue);
				}
			}
			return { success: true, value: validated };
		},
	});

	return {
		description: definition.description,
		inputSchema: schema,
		execute: async (input: Record<string, string>, executeOptions?: { toolCallId?: string }) => {
			if (context.abortSignal?.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}

			const callContext: ToolExecutorContext = { ...context, toolCallId: executeOptions?.toolCallId };

			// Defense-in-depth: reject editing tools in non-code modes.
			if (mode !== 'code' && EDITING_TOOL_NAMES.has(toolName)) {
				logger?.warn('tool_call', 'blocked', { toolName, reason: 'editing_tool_in_non_code_mode', mode });
				return 'File editing tools are not available in this mode. Switch to Code mode to make changes.';
			}

			logger?.info('tool_call', 'started', { toolName, input: sanitizeToolInput(input) });
			const timer = logger?.startTimer();

			try {
				const result = await executor(input, sendEvent, callContext, queryChanges);
				logger?.info(
					'tool_call',
					'completed',
					{ toolName, resultSummary: summarizeToolResult(result.output), resultLength: result.output.length },
					{ durationMs: timer?.() },
				);
				sendEvent('tool_result', { tool_name: toolName, title: result.title, metadata: result.metadata });
				return result.output;
			} catch (error) {
				const isToolError = error instanceof ToolExecutionError;
				logger?.[isToolError ? 'warn' : 'error'](
					'tool_call',
					isToolError ? 'tool_error' : 'error',
					{
						toolName,
						errorCode: isToolError ? error.code : undefined,
						error: error instanceof Error ? error.message : String(error),
						stack: isToolError ? undefined : error instanceof Error ? error.stack : undefined,
					},
					{ durationMs: timer?.() },
				);
				toolFailures?.push({
					toolName,
					errorCode: isToolError ? error.code : undefined,
					errorMessage: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	};
}

/**
 * Browser Run tools, exposed inside Code Mode as `tools.browser_*`. Quick
 * Actions are read-only page reads (every mode); the durable `browser_execute`
 * can mutate page state, so it is code-mode only. Both are restricted to the
 * project's preview origin(s).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool generic variance; mixed AI SDK tool shapes
async function addBrowserTools(target: Record<string, any>, context: ToolExecutorContext, mode: 'code' | 'plan' | 'ask'): Promise<void> {
	if (!context.ctx || !context.loader || !context.browser || !context.requestOriginContext) return;

	const { createBrowserTools } = await import('@cloudflare/think/tools/browser');
	const browserTools = createBrowserTools({
		ctx: context.ctx,
		browser: context.browser,
		loader: context.loader,
		session: { mode: 'dynamic' },
	});

	const secret = import.meta.env.DEV ? env.PREVIEW_SECRET || DEV_PREVIEW_SECRET : env.PREVIEW_SECRET;
	const allowedPreviewOrigins = await buildAllowedPreviewOrigins(context.projectId, context.requestOriginContext, secret);
	const primaryPreviewOrigin = allowedPreviewOrigins[0];

	for (const quickActionName of QUICK_ACTION_TOOL_NAMES) {
		const quickActionTool = browserTools[quickActionName];
		if (quickActionTool) {
			target[quickActionName] = wrapQuickActionTool(quickActionTool, allowedPreviewOrigins);
		}
	}

	if (mode === 'code') {
		const browserExecute = browserTools.browser_execute;
		target.browser_execute = {
			...browserExecute,
			execute: async (input: { code: string }) => {
				if (!primaryPreviewOrigin) {
					throw new ToolExecutionError('NOT_ALLOWED', 'browser_execute is unavailable until the project preview origin is known.');
				}
				if (typeof browserExecute.execute !== 'function') {
					throw new ToolExecutionError('NOT_ALLOWED', 'browser_execute is unavailable in the current browser tool configuration.');
				}
				return Reflect.apply(browserExecute.execute, browserExecute, [
					{ code: wrapBrowserExecuteCode(input.code, primaryPreviewOrigin, allowedPreviewOrigins) },
					undefined,
				]);
			},
		};
	}
}

/**
 * Browser Run Quick Action tools exposed by `createBrowserTools`.
 * These are stateless, read-only page reads.
 */
const QUICK_ACTION_TOOL_NAMES = ['browser_markdown', 'browser_extract', 'browser_links', 'browser_scrape'] as const;

/**
 * Wrap a Quick Action tool so it can only navigate to the project's preview
 * origin(s). Quick Actions accept either a `url` or raw `html`; raw HTML never
 * navigates, so it passes through untouched.
 */
function wrapQuickActionTool(quickActionTool: { execute?: unknown }, allowedPreviewOrigins: string[]): AnyTool {
	const originalExecute = quickActionTool.execute;
	if (typeof originalExecute !== 'function') {
		return quickActionTool;
	}

	const allowedOrigins = new Set(allowedPreviewOrigins);
	return {
		...quickActionTool,
		execute: async (input: Record<string, unknown>, options?: unknown) => {
			if (typeof input.url === 'string') {
				let parsed: URL;
				try {
					parsed = new URL(input.url);
				} catch {
					throw new ToolExecutionError('MISSING_INPUT', 'Browser tool URLs must be valid absolute URLs.');
				}
				if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
					throw new ToolExecutionError('NOT_ALLOWED', 'Browser tools only support http:// and https:// preview URLs.');
				}
				if (!allowedOrigins.has(parsed.origin)) {
					throw new ToolExecutionError(
						'NOT_ALLOWED',
						`Browser tools may only read this project's preview origin. Allowed origins: ${allowedPreviewOrigins.join(', ')}`,
					);
				}
			}
			return Reflect.apply(originalExecute, quickActionTool, [input, options]);
		},
	};
}

function wrapBrowserExecuteCode(code: string, primaryPreviewOrigin: string, allowedPreviewOrigins: string[]): string {
	const allowedOriginsJson = JSON.stringify(allowedPreviewOrigins);
	const primaryOriginJson = JSON.stringify(primaryPreviewOrigin);
	return `async () => {
  const __allowedOrigins = new Set(${allowedOriginsJson});
  const __primaryOrigin = ${primaryOriginJson};
  const __normalizeUrl = (value) => {
    if (typeof value !== "string") {
      throw new Error("browser_execute navigation URLs must be strings.");
    }
    if (value === "about:blank") {
      return value;
    }
    if (value.startsWith("/") || value.startsWith("?") || value.startsWith("#")) {
      return new URL(value, __primaryOrigin).toString();
    }
    return value;
  };
  const __assertAllowedTarget = (value) => {
    const normalized = __normalizeUrl(value);
    if (normalized === "about:blank") {
      return normalized;
    }
    const parsed = new URL(normalized);
			if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
				throw new Error("browser_execute only supports http:// and https:// preview URLs.");
			}
			if (!__allowedOrigins.has(parsed.origin)) {
				throw new Error("browser_execute may only navigate to this project's preview origin. Allowed origins: ${allowedPreviewOrigins.join(', ')}");
			}
    return parsed.toString();
  };
  const __originalSend = cdp.send.bind(cdp);
  cdp.send = async (method, params, options) => {
    if ((method === "Target.createTarget" || method === "Page.navigate") && params && typeof params === "object" && "url" in params) {
      params = { ...params, url: __assertAllowedTarget(params.url) };
    }
    return __originalSend(method, params, options);
  };
  const __userFunction = (${code});
  if (typeof __userFunction !== "function") {
    throw new Error("browser_execute expects an async arrow function.");
  }
  return await __userFunction();
}`;
}

export { createSendEventFunction as createSendEvent } from '../event-helpers';
