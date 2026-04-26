import { generateText, streamText } from 'ai';
import { mount, withMounts } from 'worker-fs-mount';

import { messagePartsToPromptText } from '@shared/chat-message-parts';
import { DEFAULT_AI_MODEL, getModelConfig, getModelLimits } from '@shared/constants';

import { AgentLogger } from './agent-logger';
import {
	estimateMessagesTokens,
	getContextUtilization,
	hasContextBudget,
	microCompactMessages,
	pruneOldAssistantText,
	pruneSystemMessages,
	pruneToolOutputs,
	responseMessagesToChatMessages,
} from './context-pruner';
import { detectDoomLoop, MUTATION_FAILURE_TAG } from './doom-loop';
import {
	contextUtilizationEvent,
	doomLoopDetectedEvent,
	maxIterationsReachedEvent,
	reasoningDeltaEvent,
	runErrorEvent,
	snapshotDeletedEvent,
	statusEvent,
	textDeltaEvent,
	toolCallArgumentsDeltaEvent,
	toolCallEndEvent,
	toolCallStartEvent,
	turnCompleteEvent,
	usageEvent,
} from './event-helpers';
import { McpClientManager } from './mcp-client';
import { buildDiagnosticsArtifactEntry } from './memory/artifacts';
import { accumulatePendingChange, pendingChangesMapToRecord } from './pending-changes';
import { savePlan } from './plan-saver';
import { classifyRetryableError, calculateRetryDelay, sleep } from './retry';
import { addFileToSnapshot, deleteDirectoryRecursive, initSnapshot } from './snapshot-manager';
import { buildRuntimePromptAdditions } from './system-prompt-builder';
import { deriveFallbackTitle } from './title-generator';
import { TokenTracker } from './token-tracker';
import { readTodos } from './tool-executor';
import { createServerTools, MUTATION_TOOL_NAMES, SUB_AGENT_EXCLUDED_TOOLS, createSendEvent } from './tools';
import { parseApiError } from './utilities';
import { createAdapter as createWorkersAiAdapter } from './workers-ai/adapter';
import { coordinatorNamespace } from '../../lib/durable-object-namespaces';

import type { RequestOriginContext } from './request-origin-context';
import type { SnapshotContext } from './snapshot-manager';
import type {
	FileChange,
	PendingToolCallIds,
	SessionPersistData,
	StreamEventQueue,
	ToolCallIdReference,
	ToolExecutorContext,
	ToolFailureRecord,
} from './types';
import type { ProjectFilesystem } from '../../durable/project-filesystem';
import type { ExtensionManager } from '@cloudflare/think/extensions';
import type { FiberSnapshot, StreamEvent } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { AssetSettings, BindingsConfig, ChatMessage, PendingFileChange, ToolErrorInfo, ToolMetadataInfo } from '@shared/types';
import type { Session } from 'agents/experimental/memory/session';
import type { ModelMessage } from 'ai';

export interface AIAgentServiceOptions {
	projectRoot: string;
	projectId: string;
	fsStub: DurableObjectStub<ProjectFilesystem>;
	sessionId?: string;
	mode?: 'code' | 'plan' | 'ask';
	model?: AIModelId;
	organizationId?: string;
	initiatorUserId?: string;
	isSubAgent?: boolean;
	session?: Session;
	extensionManager?: ExtensionManager;
	loader?: WorkerLoader;
	browser?: Fetcher;
	agentReference?: import('agents').Agent<Env, unknown>;
	requestOriginContext?: RequestOriginContext;
	fiberSnapshot?: FiberSnapshot;
	initialPendingChanges?: Record<string, PendingFileChange>;
	onPersistSession?: (sessionId: string, sessionData: SessionPersistData) => Promise<void>;
	indexArtifactEntry?: (entry: { key: string; content: string }) => Promise<void>;
}

/**
 * Extract a plain text string from an AI SDK tool result value.
 *
 * Tool results from `fullStream` can be:
 * - A plain string (our tool executors return content as a string)
 * - An object `{ content: string }` (ToolResult shape from our executor wrapper)
 * - An arbitrary JSON-serializable value
 *
 * This function extracts the innermost string so the UI can inspect it
 * for error patterns like `[INVALID_PATH] ...` without JSON wrappers.
 */
function extractToolResultText(result: unknown): string {
	if (typeof result === 'string') return result;
	if (result && typeof result === 'object' && !Array.isArray(result)) {
		const record = Object.fromEntries(Object.entries(result));
		if (typeof record.content === 'string') return record.content;
		if (typeof record.error === 'string') return record.error;
	}
	return JSON.stringify(result);
}
const MAX_ITERATIONS = 200;
const MAX_RETRY_ATTEMPTS = 5;
const MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;
const SOFT_ITERATION_LIMIT = 50;
const PROACTIVE_PRUNE_THRESHOLD = 0.7;
const EMPTY_RESPONSE_RETRY_DELAY_MS = 250;
const MAX_INLINE_DIAGNOSTIC_CHARACTERS = 8000;

function truncateDiagnosticsForPrompt(content: string): string {
	if (content.length <= MAX_INLINE_DIAGNOSTIC_CHARACTERS) {
		return content;
	}

	return `... (older diagnostics truncated)\n${content.slice(-MAX_INLINE_DIAGNOSTIC_CHARACTERS)}`;
}

type ExternalChange =
	| {
			kind: 'file-edit';
			path: string;
			timestamp: number;
	  }
	| {
			kind: 'wrangler-settings';
			path: '/wrangler.jsonc';
			timestamp: number;
			domains: Array<'asset-settings' | 'bindings-config'>;
			assetSettings?: AssetSettings;
			bindingsConfig?: BindingsConfig;
	  };

function formatRunWorkerFirst(runWorkerFirst: AssetSettings['run_worker_first']): string {
	if (runWorkerFirst === true) {
		return 'enabled for all requests';
	}
	if (Array.isArray(runWorkerFirst) && runWorkerFirst.length > 0) {
		return `enabled for patterns ${runWorkerFirst.join(', ')}`;
	}
	return 'disabled';
}

function buildWranglerSettingsSummary(change: Extract<ExternalChange, { kind: 'wrangler-settings' }>): string[] {
	const summaryLines: string[] = [];
	if (change.domains.includes('asset-settings')) {
		const assetSettings = change.assetSettings ?? {};
		summaryLines.push(
			`asset settings → not_found_handling=${assetSettings.not_found_handling ?? 'none'}, html_handling=${assetSettings.html_handling ?? 'auto-trailing-slash'}, run_worker_first=${formatRunWorkerFirst(assetSettings.run_worker_first)}`,
		);
	}
	if (change.domains.includes('bindings-config')) {
		summaryLines.push(`bindings config → storage=${change.bindingsConfig?.storage ? 'enabled' : 'disabled'}`);
	}

	return summaryLines;
}

function buildExternalChangesPrompt(changes: ExternalChange[]): string | undefined {
	const fileEdits = changes.filter((change): change is Extract<ExternalChange, { kind: 'file-edit' }> => change.kind === 'file-edit');
	const wranglerSettingsChanges = changes.filter(
		(change): change is Extract<ExternalChange, { kind: 'wrangler-settings' }> => change.kind === 'wrangler-settings',
	);
	if (fileEdits.length === 0 && wranglerSettingsChanges.length === 0) {
		return undefined;
	}

	const promptLines = ['SYSTEM: While you were working, a user changed project state outside the agent loop.'];
	if (fileEdits.length > 0) {
		promptLines.push(
			`- File edits: ${fileEdits.map((change) => change.path).join(', ')}`,
			'- If any of these files are relevant to your task, re-read them with file_read before making further changes.',
		);
	}
	if (wranglerSettingsChanges.length > 0) {
		promptLines.push('- Wrangler settings changed in /wrangler.jsonc:');
		for (const change of wranglerSettingsChanges) {
			for (const summaryLine of buildWranglerSettingsSummary(change)) {
				promptLines.push(`  - ${summaryLine}`);
			}
		}
		promptLines.push(
			'- If these settings matter to your task, refresh your understanding with the dedicated settings/bindings tools before changing related code.',
		);
	}

	return promptLines.join('\n');
}

export class AIAgentService {
	private mcpClientManager = new McpClientManager();
	private agentLogger: AgentLogger | undefined;
	private readonly options: AIAgentServiceOptions & { mode: 'code' | 'plan' | 'ask'; model: AIModelId; isSubAgent: boolean };

	getLogger(): AgentLogger | undefined {
		return this.agentLogger;
	}

	constructor(options: AIAgentServiceOptions) {
		this.options = {
			...options,
			mode: options.mode ?? 'code',
			model: options.model ?? DEFAULT_AI_MODEL,
			isSubAgent: options.isSubAgent ?? false,
		};
	}

	/**
	 * Run the AI agent loop, returning an async iterable of StreamEvent objects.
	 *
	 * The loop manages its own message building (ChatMessage[]) for session
	 * persistence, and emits StreamEvent objects for the caller to broadcast
	 * to connected clients.
	 */
	runAgentStream(messages: ModelMessage[], chatMessages: ChatMessage[], abortController: AbortController): AsyncIterable<StreamEvent> {
		const logger = new AgentLogger(this.options.sessionId, this.options.projectId, this.options.model, this.options.mode);
		this.agentLogger = logger;

		// We need to run inside withMounts for filesystem access.
		// Use a TransformStream as a bridge between the mount scope and the caller.
		const { readable, writable } = new TransformStream<StreamEvent>();
		const writer = writable.getWriter();

		void withMounts(async () => {
			mount(this.options.projectRoot, this.options.fsStub);
			const innerStream = this.createAgentStream(messages, chatMessages, abortController, logger);
			try {
				for await (const event of innerStream) {
					await writer.write(event);
				}
				await writer.close();
			} catch (error) {
				await writer.abort(error);
			}
		});

		return readable;
	}
	async flushLogger(): Promise<void> {
		const logger = this.agentLogger;
		if (!logger || logger.isFlushed) return;

		await withMounts(async () => {
			mount(this.options.projectRoot, this.options.fsStub);
			await logger.flush(this.options.projectRoot);
		});
	}

	getFsStub(): DurableObjectStub<ProjectFilesystem> {
		return this.options.fsStub;
	}

	// =============================================================================
	// Agent Loop
	// =============================================================================

	/**
	 * Create the stream event iterable that drives the agent loop.
	 *
	 * This async generator:
	 * 1. Runs the agent loop manually (streamText() per iteration)
	 * 2. Emits typed StreamEvent objects for text deltas, tool calls, status, etc.
	 * 3. Manages session persistence via the onPersistSession callback
	 * 4. Handles retry, context pruning, doom loop detection
	 */
	private async *createAgentStream(
		messages: ModelMessage[],
		chatMessages: ChatMessage[],
		abortController: AbortController,
		logger?: AgentLogger,
	): AsyncIterable<StreamEvent> {
		const signal = abortController.signal;
		const queryChanges: FileChange[] = this.options.fiberSnapshot?.queryChanges ? [...this.options.fiberSnapshot.queryChanges] : [];
		const tokenTracker = new TokenTracker();
		const eventQueue: StreamEventQueue = [];
		logger ??= new AgentLogger(this.options.sessionId, this.options.projectId, this.options.model, this.options.mode);

		logger.info('agent_loop', 'started', {
			mode: this.options.mode,
			model: this.options.model,
			sessionId: this.options.sessionId,
			messageCount: messages.length,
			maxIterations: MAX_ITERATIONS,
			softLimit: SOFT_ITERATION_LIMIT,
		});

		const toolCallIdReference: ToolCallIdReference = { current: undefined };
		const pendingToolCallIds: PendingToolCallIds = [];
		const sendEvent = createSendEvent(eventQueue, toolCallIdReference, signal);

		// Eagerly create a snapshot directory for code mode
		let snapshotContext: SnapshotContext | undefined;
		if (this.options.mode === 'code') {
			snapshotContext = await initSnapshot(this.options.projectRoot, this.options.sessionId, messages, sendEvent);
			logger.debug('snapshot', 'created', { snapshotId: snapshotContext.id });
			while (eventQueue.length > 0) {
				const queued = eventQueue.shift();
				if (queued) yield queued;
			}
		}

		const coordinatorStub = coordinatorNamespace.getByName(`project:${this.options.projectId}`);

		// Accumulate metadata for session persistence
		let sessionSnapshotId: string | undefined = this.options.fiberSnapshot?.snapshotId ?? snapshotContext?.id;
		const userMessageIndex = chatMessages.length - 1;
		let contextTokensUsed = this.options.fiberSnapshot?.contextTokensUsed ?? 0;
		let sessionPersisted = false;
		const streamPendingChanges = new Map<string, PendingFileChange>(Object.entries(this.options.initialPendingChanges ?? {}));
		const streamToolMetadata = new Map<string, ToolMetadataInfo>(Object.entries(this.options.fiberSnapshot?.toolMetadata ?? {}));
		const streamToolErrors = new Map<string, ToolErrorInfo>(Object.entries(this.options.fiberSnapshot?.toolErrors ?? {}));

		// Mutable chat history that grows as the agent loop progresses.
		// Starts with the caller-supplied messages (user prompt + any prior history)
		// and gets each turn's assistant+tool response messages appended after
		// response.messages is received. This is what gets persisted to SQLite.
		const currentChatMessages = this.options.fiberSnapshot?.chatMessages ? [...this.options.fiberSnapshot.chatMessages] : [...chatMessages];
		const workingMessages = this.options.fiberSnapshot?.workingMessages ? [...this.options.fiberSnapshot.workingMessages] : [...messages];
		let iteration = this.options.fiberSnapshot?.iteration ?? 0;

		// Session persistence helper
		const persistSession = async () => {
			sessionPersisted = true;
			if (!this.options.sessionId || !this.options.onPersistSession) return;
			try {
				if (sessionSnapshotId && userMessageIndex >= 0) {
					const userMessage = currentChatMessages[userMessageIndex];
					if (userMessage) {
						currentChatMessages[userMessageIndex] = {
							...userMessage,
							metadata: {
								...userMessage.metadata,
								snapshotId: sessionSnapshotId,
							},
						};
					}
				}
				const firstUserMessage = chatMessages.find((message) => message.role === 'user');
				const firstUserText = firstUserMessage ? messagePartsToPromptText(firstUserMessage.parts).trim() : '';

				await this.options.onPersistSession(this.options.sessionId, {
					createdAt: Date.now(),
					title: deriveFallbackTitle(firstUserText),
					history: currentChatMessages,
					contextTokensUsed: contextTokensUsed > 0 ? contextTokensUsed : undefined,
					toolMetadata: streamToolMetadata.size > 0 ? Object.fromEntries(streamToolMetadata) : undefined,
					toolErrors: streamToolErrors.size > 0 ? Object.fromEntries(streamToolErrors) : undefined,
					pendingChanges: streamPendingChanges.size > 0 ? (pendingChangesMapToRecord(streamPendingChanges) ?? undefined) : undefined,
					fiberSnapshot: {
						workingMessages,
						chatMessages: currentChatMessages,
						iteration,
						queryChanges: queryChanges.map((change) => ({
							path: change.path,
							action: change.action,
							beforeContent: typeof change.beforeContent === 'string' ? change.beforeContent : undefined,
							afterContent: typeof change.afterContent === 'string' ? change.afterContent : undefined,
							isBinary: change.isBinary,
						})),
						pendingChanges: streamPendingChanges.size > 0 ? (pendingChangesMapToRecord(streamPendingChanges) ?? {}) : {},
						toolMetadata: streamToolMetadata.size > 0 ? Object.fromEntries(streamToolMetadata) : {},
						toolErrors: streamToolErrors.size > 0 ? Object.fromEntries(streamToolErrors) : {},
						contextTokensUsed,
						snapshotId: sessionSnapshotId,
						model: this.options.model,
						mode: this.options.mode,
					},
				});
			} catch (error) {
				logger?.error('session', 'persist_failed', { error: error instanceof Error ? error.message : String(error) });
			}
		};

		try {
			yield statusEvent('Starting...');
			const outputLogs = await coordinatorStub.getOutputLogs().catch((): string | undefined => undefined);
			if (outputLogs?.trim() && this.options.indexArtifactEntry) {
				await this.indexArtifact(buildDiagnosticsArtifactEntry(this.options.sessionId, outputLogs, 'initial'), logger);
			}

			const runtimePromptAdditions = await buildRuntimePromptAdditions(
				this.options.projectRoot,
				this.options.mode,
				outputLogs,
				this.options.sessionId,
			);

			const modelConfig = getModelConfig(this.options.model);
			if (!modelConfig) throw new Error(`Unknown model: ${this.options.model}`);

			const languageModel = createWorkersAiAdapter(this.options.model, {
				generationType: 'agent',
				projectId: this.options.projectId,
				organizationId: this.options.organizationId,
				userId: this.options.initiatorUserId,
			});
			const modelLimits = getModelLimits(this.options.model);

			const toolContext: ToolExecutorContext = {
				projectRoot: this.options.projectRoot,
				projectId: this.options.projectId,
				organizationId: this.options.organizationId,
				mode: this.options.mode,
				sessionId: this.options.sessionId,
				userId: this.options.initiatorUserId,
				session: this.options.session,
				abortSignal: signal,
				callMcpTool: (serverId, toolName, arguments_) => this.mcpClientManager.callTool(serverId, toolName, arguments_),
				loader: this.options.loader,
				browser: this.options.browser,
				agentReference: this.options.agentReference,
				extensionManager: this.options.extensionManager,
				fsStub: this.options.fsStub,
				model: this.options.model,
				isSubAgent: this.options.isSubAgent,
				requestOriginContext: this.options.requestOriginContext,
				indexArtifact: this.options.indexArtifactEntry,
			};

			if (outputLogs?.trim() && this.options.indexArtifactEntry) {
				workingMessages.push({
					role: 'user',
					content:
						'SYSTEM: Recent IDE diagnostics were indexed into the searchable ARTIFACTS context for this session. Search artifacts before diagnosing build, runtime, or lint failures.',
				});
			} else if (outputLogs?.trim()) {
				workingMessages.push({
					role: 'user',
					content: `SYSTEM: Recent IDE diagnostics:\n\n<output_logs>\n${truncateDiagnosticsForPrompt(outputLogs)}\n</output_logs>`,
				});
			}

			// Mutable copy of messages for the agent loop
			const currentRunStartIndex = workingMessages.length;

			let continueLoop = true;
			let hitIterationLimit = false;
			let lastAssistantText = '';
			let softLimitNudged = false;
			let planModeTodoNudged = false;
			let previousIterationHadMutationFailure = false;

			while (continueLoop && iteration < MAX_ITERATIONS) {
				if (signal.aborted) {
					logger.info('agent_loop', 'aborted', { iteration });
					logger.markAborted();
					yield statusEvent('Interrupted');
					break;
				}

				iteration++;
				logger.setIteration(iteration);

				// Soft iteration nudge
				if (iteration === SOFT_ITERATION_LIMIT && !softLimitNudged) {
					softLimitNudged = true;
					workingMessages.push({
						role: 'user',
						content: 'SYSTEM: You have been working for many iterations. Please try to wrap up the current task efficiently.',
					});
				}

				let messagesForModel = microCompactMessages(workingMessages);
				const estimatedTokens = estimateMessagesTokens(messagesForModel);
				contextTokensUsed = estimatedTokens;
				let contextUtilization = getContextUtilization(messagesForModel, modelLimits);
				yield contextUtilizationEvent(estimatedTokens, modelLimits.contextWindow, Math.round(contextUtilization * 100));
				yield statusEvent(this.options.mode === 'plan' ? 'Researching...' : 'Thinking...');

				// Proactive pruning — multi-stage, from cheapest to most aggressive
				if (contextUtilization >= PROACTIVE_PRUNE_THRESHOLD) {
					let totalPruned = 0;

					// Stage 1: Prune old tool outputs (and corresponding write-tool inputs)
					const { messages: stage1, prunedTokens: stage1Tokens } = pruneToolOutputs(workingMessages);
					if (stage1Tokens > 0) {
						workingMessages.length = 0;
						workingMessages.push(...stage1);
						totalPruned += stage1Tokens;
					}

					// Stage 2: Prune old corrective system messages
					const { messages: stage2, prunedTokens: stage2Tokens } = pruneSystemMessages(workingMessages);
					if (stage2Tokens > 0) {
						workingMessages.length = 0;
						workingMessages.push(...stage2);
						totalPruned += stage2Tokens;
					}

					// Stage 3: If still very full (>90%), truncate old assistant text
					const postStage2Utilization = getContextUtilization(microCompactMessages(workingMessages), modelLimits);
					if (postStage2Utilization >= 0.9) {
						const { messages: stage4, prunedTokens: stage4Tokens } = pruneOldAssistantText(workingMessages);
						if (stage4Tokens > 0) {
							workingMessages.length = 0;
							workingMessages.push(...stage4);
							totalPruned += stage4Tokens;
						}
					}

					if (totalPruned > 0) {
						messagesForModel = microCompactMessages(workingMessages);
						const postPruneTokens = estimateMessagesTokens(messagesForModel);
						const postPruneUtilization = getContextUtilization(messagesForModel, modelLimits);
						contextTokensUsed = postPruneTokens;
						contextUtilization = postPruneUtilization;
						yield contextUtilizationEvent(postPruneTokens, modelLimits.contextWindow, Math.round(postPruneUtilization * 100));
						yield statusEvent(`Pruned ${totalPruned} tokens of old context`);
					}
				}

				// Context budget check
				if (!hasContextBudget(messagesForModel, modelLimits)) {
					yield statusEvent('Context window exhausted');
					hitIterationLimit = true;
					break;
				}

				// Create tools for this iteration.
				// After a mutation failure, temporarily exclude mutation tools to force
				// the agent to re-read files before retrying edits.
				const changeCountBefore = queryChanges.length;
				const toolFailures: ToolFailureRecord[] = [];
				pendingToolCallIds.length = 0;
				const drainToolFailures = (toolCallId: string) => {
					for (const failure of toolFailures) {
						if (MUTATION_TOOL_NAMES.has(failure.toolName)) {
							hadMutationFailure = true;
						}
						streamToolErrors.set(toolCallId, {
							toolCallId,
							toolName: failure.toolName,
							errorCode: failure.errorCode ?? '',
							errorMessage: failure.errorMessage,
						});
					}
					toolFailures.length = 0;
				};
				const baseExcludedTools = this.options.isSubAgent ? SUB_AGENT_EXCLUDED_TOOLS : undefined;
				const iterationExcludedTools = previousIterationHadMutationFailure
					? baseExcludedTools
						? new Set([...baseExcludedTools, ...MUTATION_TOOL_NAMES])
						: MUTATION_TOOL_NAMES
					: baseExcludedTools;
				previousIterationHadMutationFailure = false;
				const tools = await createServerTools(
					sendEvent,
					toolContext,
					queryChanges,
					this.options.mode,
					logger,
					toolFailures,
					toolCallIdReference,
					pendingToolCallIds,
					iterationExcludedTools,
				);
				const frozenSystemPrompt = this.options.session ? await this.options.session.freezeSystemPrompt().catch(() => '') : '';
				const systemPrompt = `${frozenSystemPrompt}${runtimePromptAdditions ? `\n\n${runtimePromptAdditions}` : ''}`.trim();

				// ─── Call streamText() ───────────────────────────────────────
				let hadToolCalls = false;
				let hadUserQuestion = false;
				let hadMutationFailure = false;
				let retryAttempt = 0;
				let outputRecoveryAttempts = 0;
				const llmTimer = logger.startTimer();

				let latestFinishReason: string | undefined;
				let responseMessageCount = 0;

				while (true) {
					// Reset per-attempt state so failed attempts don't contaminate retries.
					hadToolCalls = false;
					hadUserQuestion = false;
					hadMutationFailure = false;
					lastAssistantText = '';
					toolFailures.length = 0;

					let streamError: string | undefined;
					let caughtStreamError: unknown;
					latestFinishReason = undefined;

					try {
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- ToolSet generic variance; dynamically-built tools can't satisfy the strict generic
						const typedTools: Parameters<typeof streamText>[0]['tools'] = tools as any;
						const result = streamText({
							model: languageModel,
							messages: messagesForModel,
							system: systemPrompt,
							tools: typedTools,
							maxOutputTokens: modelLimits.maxOutput,
							abortSignal: signal,
							// Automatically repair invalid tool calls by re-asking the model.
							// Smaller models sometimes produce malformed JSON for tool inputs;
							// this gives the model a second chance using the error + schema.
							experimental_repairToolCall: async ({
								toolCall,
								tools: availableTools,
								error,
								messages: callMessages,
								system: callSystem,
							}) => {
								const repairResult = await generateText({
									model: languageModel,
									system: callSystem,
									messages: [
										...callMessages,
										{
											role: 'assistant',
											content: [
												{
													type: 'tool-call',
													toolCallId: toolCall.toolCallId,
													toolName: toolCall.toolName,
													input: toolCall.input,
												},
											],
										},
										{
											role: 'tool',
											content: [
												{
													type: 'tool-result',
													toolCallId: toolCall.toolCallId,
													toolName: toolCall.toolName,
													output: { type: 'text', value: error.message },
												},
											],
										},
									],
									tools: availableTools,
								});

								const repairedCall = repairResult.toolCalls.find((tc: { toolName: string }) => tc.toolName === toolCall.toolName);

								// eslint-disable-next-line unicorn/no-null -- AI SDK requires null (not undefined) for "no repair"
								if (!repairedCall) return null;

								return {
									...toolCall,
									input: JSON.stringify(repairedCall.input),
								};
							},
						});

						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- fullStream generic tied to tools type
						for await (const part of result.fullStream as AsyncIterable<any>) {
							if (signal.aborted) break;

							switch (part.type) {
								case 'text-delta': {
									lastAssistantText += part.text;
									yield textDeltaEvent(part.text);
									break;
								}
								case 'reasoning-delta': {
									yield reasoningDeltaEvent(part.text);
									break;
								}
								case 'tool-input-delta': {
									yield toolCallArgumentsDeltaEvent(part.id, part.delta);
									break;
								}
								case 'tool-call': {
									hadToolCalls = true;
									toolCallIdReference.current = part.toolCallId;
									yield toolCallStartEvent(part.toolCallId, part.toolName);

									if (part.toolName === 'user_question') {
										hadUserQuestion = true;
									}
									break;
								}
								case 'tool-result': {
									const resultText = extractToolResultText(part.output);
									yield toolCallEndEvent(part.toolCallId, part.toolName, resultText);

									// Drain tool event queue
									while (eventQueue.length > 0) {
										const queued = eventQueue.shift();
										if (queued) {
											// Track metadata from tool events
											switch (queued.type) {
												case 'file-changed': {
													accumulatePendingChange(streamPendingChanges, {
														path: queued.path,
														action: queued.action,
														beforeContent: queued.beforeContent,
														afterContent: queued.afterContent,
														snapshotId: sessionSnapshotId,
														sessionId: this.options.sessionId ?? '',
													});

													break;
												}
												case 'tool-result': {
													streamToolMetadata.set(queued.toolCallId, {
														toolCallId: queued.toolCallId,
														toolName: queued.toolName,
														title: queued.title,
														metadata: queued.metadata,
													});

													break;
												}
												case 'snapshot-created': {
													sessionSnapshotId = queued.id;

													break;
												}
												case 'snapshot-deleted': {
													sessionSnapshotId = undefined;

													break;
												}
												// No default
											}
											yield queued;
										}
									}

									drainToolFailures(part.toolCallId);
									break;
								}
								case 'tool-error': {
									const errorText = part.error instanceof Error ? part.error.message : String(part.error ?? 'Tool error');
									yield toolCallEndEvent(part.toolCallId, part.toolName, errorText, true);
									drainToolFailures(part.toolCallId);
									break;
								}
								case 'finish-step': {
									if (part.usage) {
										tokenTracker.recordTurn(this.options.model, {
											inputTokens: part.usage.inputTokens ?? 0,
											outputTokens: part.usage.outputTokens ?? 0,
											cacheReadInputTokens: part.usage.inputTokenDetails?.cacheReadTokens ?? 0,
											cacheCreationInputTokens: part.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
										});
										logger.recordTokenUsage(part.usage.inputTokens ?? 0, part.usage.outputTokens ?? 0);
										if ((part.usage.inputTokens ?? 0) > 0) {
											yield contextUtilizationEvent(
												part.usage.inputTokens ?? 0,
												modelLimits.contextWindow,
												Math.round(((part.usage.inputTokens ?? 0) / (modelLimits.contextWindow - modelLimits.maxOutput)) * 100),
											);
										}
									}
									logger.info(
										'llm',
										'request_end',
										{
											finishReason: part.finishReason,
											inputTokens: part.usage?.inputTokens,
											outputTokens: part.usage?.outputTokens,
										},
										{ durationMs: llmTimer() },
									);
									break;
								}
								case 'finish': {
									latestFinishReason = part.finishReason;
									break;
								}
								case 'error': {
									streamError = part.error instanceof Error ? part.error.message : String(part.error);
									break;
								}
								// step-start, step-finish, reasoning, etc. — pass through
							}
						}

						// Wait for the result to fully complete (including tool executions).
						// Capture response messages (assistant + tool results) to append to workingMessages.
						const response = await result.response;
						// Append the response messages so the next iteration sees tool calls and results.
						// response.messages can be undefined when the model returns a reasoning-only
						// turn (thinks but produces no text or tool output).
						const responseMessages = response.messages ?? [];
						responseMessageCount = responseMessages.length;
						workingMessages.push(...responseMessages);
						// Also append to currentChatMessages so persistSession saves the full history.
						const newChatMessages = responseMessagesToChatMessages(responseMessages);
						currentChatMessages.push(...newChatMessages);
					} catch (error) {
						caughtStreamError = error;
					}

					// Drain remaining events
					if (signal.aborted) {
						eventQueue.length = 0;
					} else {
						while (eventQueue.length > 0) {
							const queued = eventQueue.shift();
							if (queued) yield queued;
						}
					}

					// Retry logic
					const errorToClassify = caughtStreamError ?? (streamError ? new Error(streamError) : undefined);
					if (errorToClassify) {
						if (errorToClassify instanceof Error && errorToClassify.name === 'AbortError') {
							throw errorToClassify;
						}

						retryAttempt++;
						const retryReason = classifyRetryableError(errorToClassify);

						if (retryReason && retryAttempt < MAX_RETRY_ATTEMPTS) {
							const delay = calculateRetryDelay(retryAttempt, errorToClassify);
							yield statusEvent(`Retrying (${retryReason})...`);
							await sleep(delay, signal);
							continue;
						}

						if (caughtStreamError) throw caughtStreamError;

						yield runErrorEvent(streamError ?? 'Unknown error');
						continueLoop = false;
						break;
					}

					// Output token recovery — if the model was truncated mid-response,
					// ask it to continue (up to MAX_OUTPUT_RECOVERY_ATTEMPTS times).
					if (latestFinishReason === 'length' && outputRecoveryAttempts < MAX_OUTPUT_RECOVERY_ATTEMPTS) {
						outputRecoveryAttempts++;
						logger.info('agent_loop', 'output_recovery', {
							attempt: outputRecoveryAttempts,
							maxAttempts: MAX_OUTPUT_RECOVERY_ATTEMPTS,
						});
						workingMessages.push({
							role: 'user',
							content: 'SYSTEM: Your previous response was truncated due to output token limits. Continue exactly where you left off.',
						});
						yield statusEvent('Continuing truncated response...');
						continue;
					}

					const isEmptyStopResponse =
						latestFinishReason === 'stop' && !hadToolCalls && responseMessageCount === 0 && lastAssistantText.length === 0;

					if (isEmptyStopResponse) {
						retryAttempt++;
						if (retryAttempt < MAX_RETRY_ATTEMPTS) {
							yield statusEvent('Retrying empty response...');
							await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS, signal);
							continue;
						}

						yield runErrorEvent('The model returned an empty response. Please try again.');
						continueLoop = false;
						break;
					}

					// Success — exit retry loop
					break;
				}

				// Persist file changes to snapshot
				if (snapshotContext && queryChanges.length > changeCountBefore) {
					for (let index = changeCountBefore; index < queryChanges.length; index++) {
						await addFileToSnapshot(snapshotContext, queryChanges[index]);
					}
				}

				// Response messages (assistant + tool results) were already appended
				// to workingMessages via response.messages above. Add corrective
				// system messages for the next iteration if needed.
				if (hadToolCalls) {
					if (hadMutationFailure) {
						previousIterationHadMutationFailure = true;
						workingMessages.push({
							role: 'user',
							content: `${MUTATION_FAILURE_TAG} SYSTEM: One or more mutation tools FAILED this turn. Before retrying, you MUST file_read the target file(s) to see their ACTUAL current content.`,
						});
					}

					// Plan mode todo nudge
					if (this.options.mode === 'plan' && !planModeTodoNudged && iteration > 1) {
						const currentTodos = await readTodos(this.options.projectRoot, this.options.sessionId);
						if (currentTodos.length === 0) {
							planModeTodoNudged = true;
							workingMessages.push({
								role: 'user',
								content: 'SYSTEM: You are in PLAN MODE. You MUST create a structured todo list using `todos_update`.',
							});
						}
					}
				} else {
					// No tool calls — text only, stop the loop.
					// The assistant message is already in workingMessages via response.messages.
					continueLoop = false;
				}

				// Probe for output errors after file changes
				const fileChangesThisIteration = queryChanges.length - changeCountBefore;
				if (continueLoop && fileChangesThisIteration > 0) {
					try {
						await sleep(2000, signal);
						const freshLogs = await coordinatorStub.getOutputLogs();
						if (freshLogs) {
							const hasErrors = /\bERROR:/i.test(freshLogs) || /\bWARNING:/i.test(freshLogs);
							if (hasErrors) {
								if (this.options.indexArtifactEntry) {
									await this.indexArtifact(buildDiagnosticsArtifactEntry(this.options.sessionId, freshLogs, 'post-change'), logger);
									workingMessages.push({
										role: 'user',
										content:
											'SYSTEM: The IDE output panel shows new warnings or errors after your recent changes. The full diagnostics were indexed into searchable ARTIFACTS context. Search artifacts before making another fix.',
									});
								} else {
									workingMessages.push({
										role: 'user',
										content: `SYSTEM: The IDE output panel shows new warnings or errors after your recent changes.\n\n<output_logs>\n${truncateDiagnosticsForPrompt(freshLogs)}\n</output_logs>`,
									});
								}
								yield statusEvent('Detected output errors, reviewing...');
							}
						}
					} catch {
						// Non-fatal
					}
				}

				// Probe for concurrent user file edits
				if (continueLoop) {
					try {
						const recentExternalChanges = await coordinatorStub.getRecentExternalChanges();
						const externalChangesPrompt = buildExternalChangesPrompt(recentExternalChanges);
						if (externalChangesPrompt) {
							workingMessages.push({
								role: 'user',
								content: externalChangesPrompt,
							});
							yield statusEvent('Detected user edits, reviewing...');
						}
					} catch {
						// Non-fatal — coordinator may be unavailable
					}
				}

				// Doom loop detection
				const loopResult = continueLoop ? detectDoomLoop(workingMessages, currentRunStartIndex) : { isDoomLoop: false };
				if (loopResult.isDoomLoop) {
					logger.markDoomLoop();
					yield doomLoopDetectedEvent(
						loopResult.reason ?? 'unknown',
						loopResult.toolName,
						loopResult.message ?? 'The agent was stopped to prevent an infinite loop.',
					);
					continueLoop = false;
				}

				if (hadUserQuestion) {
					continueLoop = false;
				}

				// Persist after every turn so turn-complete always reloads the full history.
				// The throttle was causing skipped persists and stale DB state.
				await persistSession();

				yield turnCompleteEvent();
			}

			// Iteration limit
			if (!hitIterationLimit && continueLoop && iteration >= MAX_ITERATIONS && !signal.aborted) {
				hitIterationLimit = true;
			}
			if (hitIterationLimit) {
				logger.markIterationLimit();
			}

			// Cleanup empty snapshots
			if (snapshotContext && queryChanges.length === 0) {
				await deleteDirectoryRecursive(snapshotContext.directory);
				sessionSnapshotId = undefined;
				if (userMessageIndex >= 0) {
					const userMessage = currentChatMessages[userMessageIndex];
					if (userMessage) {
						currentChatMessages[userMessageIndex] = {
							...userMessage,
							metadata: {
								...userMessage.metadata,
								snapshotId: undefined,
							},
						};
					}
				}
				yield snapshotDeletedEvent(snapshotContext.id);
				if (sessionPersisted) {
					sessionPersisted = false;
					await persistSession();
				}
			}

			// Save plan in plan mode
			if (this.options.mode === 'plan' && lastAssistantText.trim()) {
				yield* savePlan(this.options.projectRoot, lastAssistantText, workingMessages);
			}

			if (hitIterationLimit) {
				yield maxIterationsReachedEvent(iteration);
			}

			// Emit token usage summary
			const totalUsage = tokenTracker.getTotalUsage();
			if (totalUsage.input > 0 || totalUsage.output > 0) {
				const turns = tokenTracker.getTurns();
				const lastTurn = turns.at(-1);
				yield usageEvent(
					totalUsage.input,
					totalUsage.output,
					totalUsage.cacheRead,
					totalUsage.cacheWrite,
					tokenTracker.turnCount,
					lastTurn ? lastTurn.usage.input : 0,
				);
			}

			// Final persist and flush
			logger.info('agent_loop', 'completed', { totalIterations: iteration, totalFileChanges: queryChanges.length });
			if (!sessionPersisted) await persistSession();
			await logger.flush(this.options.projectRoot);
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				logger.markAborted();
				if (!sessionPersisted) await persistSession().catch(() => {});
				await logger.flush(this.options.projectRoot);
				if (snapshotContext && queryChanges.length === 0) {
					try {
						await deleteDirectoryRecursive(snapshotContext.directory);
					} catch {
						/* No-op */
					}
				}
				return;
			}
			logger.error('agent_loop', 'error', { message: error instanceof Error ? error.message : String(error) });
			if (!sessionPersisted) await persistSession().catch(() => {});
			await logger.flush(this.options.projectRoot);
			if (snapshotContext && queryChanges.length === 0) {
				try {
					await deleteDirectoryRecursive(snapshotContext.directory);
				} catch {
					/* No-op */
				}
			}
			const parsed = parseApiError(error);
			yield runErrorEvent(parsed.message, parsed.code);
		} finally {
			if (!logger.isFlushed) {
				logger.markAborted();
				if (!sessionPersisted) await persistSession().catch(() => {});
				await logger.flush(this.options.projectRoot).catch(() => {});
				if (snapshotContext && queryChanges.length === 0) {
					try {
						await deleteDirectoryRecursive(snapshotContext.directory);
					} catch {
						/* No-op */
					}
				}
			}
			await this.mcpClientManager.closeAll();
		}
	}

	private async indexArtifact(entry: { key: string; content: string }, logger?: AgentLogger): Promise<void> {
		if (!this.options.indexArtifactEntry) {
			return;
		}

		try {
			await this.options.indexArtifactEntry(entry);
		} catch (error) {
			logger?.warn('context', 'artifact_index_failed', {
				key: entry.key,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
