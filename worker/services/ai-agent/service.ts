/**
 * AI Agent Service.
 *
 * Orchestrates the AI agent loop with streaming response using the Vercel AI SDK.
 *
 * Key architecture:
 * - Uses Vercel AI SDK streamText() with provider-specific adapters for the LLM call
 * - Emits typed StreamEvent objects (defined in shared/agent-state.ts)
 * - Manual agent loop: one streamText() call per iteration with maxSteps: 1
 * - Integrates retry, doom loop detection, context pruning, and token tracking
 *
 * Extracted modules:
 * - event-helpers.ts    — Typed StreamEvent constructors
 * - pending-changes.ts  — Server-side pending changes accumulation
 * - snapshot-manager.ts — Snapshot lifecycle (create, populate, cleanup)
 * - system-prompt-builder.ts — System prompt assembly
 * - plan-saver.ts       — Plan mode output persistence
 * - mcp-client.ts       — MCP client connection management
 */

import { generateText, streamText } from 'ai';
import { mount, withMounts } from 'worker-fs-mount';

import { DEFAULT_AI_MODEL, getModelConfig, getModelLimits } from '@shared/constants';

import { AgentLogger } from './agent-logger';
import {
	estimateMessagesTokens,
	getContextUtilization,
	hasContextBudget,
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
import { accumulatePendingChange, pendingChangesMapToRecord } from './pending-changes';
import { savePlan } from './plan-saver';
import { classifyRetryableError, calculateRetryDelay, sleep } from './retry';
import { addFileToSnapshot, deleteDirectoryRecursive, initSnapshot } from './snapshot-manager';
import { buildSystemPrompts } from './system-prompt-builder';
import { deriveFallbackTitle } from './title-generator';
import { TokenTracker } from './token-tracker';
import { readTodos } from './tool-executor';
import { createServerTools, MUTATION_TOOL_NAMES, createSendEvent } from './tools';
import { parseApiError } from './utilities';
import { createAdapter as createWorkersAiAdapter } from './workers-ai';
import { coordinatorNamespace } from '../../lib/durable-object-namespaces';

import type { SnapshotContext } from './snapshot-manager';
import type {
	FileChange,
	PendingToolCallIds,
	StreamEventQueue,
	ToolCallIdReference,
	ToolExecutorContext,
	ToolFailureRecord,
} from './types';
import type { ExpiringFilesystem } from '../../durable/expiring-filesystem';
import type { StreamEvent } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, ChatMessage, PendingFileChange, ToolErrorInfo, ToolMetadataInfo } from '@shared/types';
import type { ModelMessage } from 'ai';

// =============================================================================
// Helpers
// =============================================================================

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

// =============================================================================
// Constants
// =============================================================================

/** Hard ceiling on agent loop iterations. */
const MAX_ITERATIONS = 200;

/** Maximum retry attempts for a single LLM call. */
const MAX_RETRY_ATTEMPTS = 5;

/** Soft iteration limit — nudge the agent to wrap up. */
const SOFT_ITERATION_LIMIT = 50;

/** Context utilization threshold for proactive pruning. */
const PROACTIVE_PRUNE_THRESHOLD = 0.7;

// =============================================================================
// AI Agent Service Class
// =============================================================================

export class AIAgentService {
	private mcpClientManager = new McpClientManager();
	private agentLogger: AgentLogger | undefined;

	getLogger(): AgentLogger | undefined {
		return this.agentLogger;
	}

	constructor(
		private projectRoot: string,
		private projectId: string,
		private fsStub: DurableObjectStub<ExpiringFilesystem>,
		private sessionId?: string,
		private mode: 'code' | 'plan' | 'ask' = 'code',
		private model: AIModelId = DEFAULT_AI_MODEL,
		private onPersistSession?: (
			sessionId: string,
			sessionData: {
				createdAt: number;
				title?: string;
				history: ChatMessage[];
				messageSnapshots?: Record<string, string>;
				messageModes?: Record<string, AgentMode>;
				contextTokensUsed?: number;
				toolMetadata?: Record<string, ToolMetadataInfo>;
				toolErrors?: Record<string, ToolErrorInfo>;
				error?: { message: string; code?: string };
			},
			pendingChanges?: Record<string, PendingFileChange>,
		) => Promise<void>,
	) {}

	/**
	 * Run the AI agent loop, returning an async iterable of StreamEvent objects.
	 *
	 * The loop manages its own message building (ChatMessage[]) for session
	 * persistence, and emits StreamEvent objects for the caller to broadcast
	 * to connected clients.
	 */
	runAgentStream(messages: ModelMessage[], chatMessages: ChatMessage[], abortController: AbortController): AsyncIterable<StreamEvent> {
		const logger = new AgentLogger(this.sessionId, this.projectId, this.model, this.mode);
		this.agentLogger = logger;

		// We need to run inside withMounts for filesystem access.
		// Use a TransformStream as a bridge between the mount scope and the caller.
		const { readable, writable } = new TransformStream<StreamEvent>();
		const writer = writable.getWriter();

		void withMounts(async () => {
			mount(this.projectRoot, this.fsStub);
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

	/**
	 * Re-flush the shared logger inside a mount scope.
	 */
	async flushLogger(): Promise<void> {
		const logger = this.agentLogger;
		if (!logger || logger.isFlushed) return;

		await withMounts(async () => {
			mount(this.projectRoot, this.fsStub);
			await logger.flush(this.projectRoot);
		});
	}

	getFsStub(): DurableObjectStub<ExpiringFilesystem> {
		return this.fsStub;
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
		const queryChanges: FileChange[] = [];
		const tokenTracker = new TokenTracker();
		const eventQueue: StreamEventQueue = [];
		logger ??= new AgentLogger(this.sessionId, this.projectId, this.model, this.mode);

		logger.info('agent_loop', 'started', {
			mode: this.mode,
			model: this.model,
			sessionId: this.sessionId,
			messageCount: messages.length,
			maxIterations: MAX_ITERATIONS,
			softLimit: SOFT_ITERATION_LIMIT,
		});

		const toolCallIdReference: ToolCallIdReference = { current: undefined };
		const pendingToolCallIds: PendingToolCallIds = [];
		const sendEvent = createSendEvent(eventQueue, toolCallIdReference, signal);

		// Eagerly create a snapshot directory for code mode
		let snapshotContext: SnapshotContext | undefined;
		if (this.mode === 'code') {
			snapshotContext = await initSnapshot(this.projectRoot, this.sessionId, messages, sendEvent);
			logger.debug('snapshot', 'created', { snapshotId: snapshotContext.id });
			while (eventQueue.length > 0) {
				const queued = eventQueue.shift();
				if (queued) yield queued;
			}
		}

		const coordinatorId = coordinatorNamespace.idFromName(`project:${this.projectId}`);
		const coordinatorStub = coordinatorNamespace.get(coordinatorId);

		// Accumulate metadata for session persistence
		let sessionSnapshotId: string | undefined = snapshotContext?.id;
		const userMessageIndex = chatMessages.length - 1;
		let contextTokensUsed = 0;
		let sessionPersisted = false;
		const streamPendingChanges = new Map<string, PendingFileChange>();
		const streamToolMetadata = new Map<string, ToolMetadataInfo>();
		const streamToolErrors = new Map<string, ToolErrorInfo>();

		// Mutable chat history that grows as the agent loop progresses.
		// Starts with the caller-supplied messages (user prompt + any prior history)
		// and gets each turn's assistant+tool response messages appended after
		// response.messages is received. This is what gets persisted to SQLite.
		const currentChatMessages = [...chatMessages];

		// Session persistence helper
		const persistSession = async () => {
			sessionPersisted = true;
			if (!this.sessionId || !this.onPersistSession) return;
			try {
				const messageSnapshots: Record<string, string> = {};
				if (sessionSnapshotId && userMessageIndex >= 0) {
					messageSnapshots[String(userMessageIndex)] = sessionSnapshotId;
				}
				const messageModes: Record<string, AgentMode> = {};
				if (userMessageIndex >= 0) {
					messageModes[String(userMessageIndex)] = this.mode;
				}
				const firstUserText =
					chatMessages
						.find((m) => m.role === 'user')
						?.parts.filter((p) => p.type === 'text')
						.map((p) => p.content)
						.join(' ')
						.trim() ?? '';

				await this.onPersistSession(
					this.sessionId,
					{
						createdAt: Date.now(),
						title: deriveFallbackTitle(firstUserText),
						history: currentChatMessages,
						messageSnapshots: Object.keys(messageSnapshots).length > 0 ? messageSnapshots : undefined,
						messageModes: Object.keys(messageModes).length > 0 ? messageModes : undefined,
						contextTokensUsed: contextTokensUsed > 0 ? contextTokensUsed : undefined,
						toolMetadata: streamToolMetadata.size > 0 ? Object.fromEntries(streamToolMetadata) : undefined,
						toolErrors: streamToolErrors.size > 0 ? Object.fromEntries(streamToolErrors) : undefined,
					},
					streamPendingChanges.size > 0 ? pendingChangesMapToRecord(streamPendingChanges) : undefined,
				);
			} catch (error) {
				logger?.error('session', 'persist_failed', { error: error instanceof Error ? error.message : String(error) });
			}
		};

		try {
			yield statusEvent('Starting...');

			// Build system prompts
			const systemPrompts = await buildSystemPrompts(this.projectRoot, this.mode, undefined, this.sessionId);
			const systemPrompt = systemPrompts.join('\n\n');

			const modelConfig = getModelConfig(this.model);
			if (!modelConfig) throw new Error(`Unknown model: ${this.model}`);

			const languageModel = createWorkersAiAdapter(this.model);
			const modelLimits = getModelLimits(this.model);

			const toolContext: ToolExecutorContext = {
				projectRoot: this.projectRoot,
				projectId: this.projectId,
				mode: this.mode,
				sessionId: this.sessionId,
				abortSignal: signal,
				callMcpTool: (serverId, toolName, arguments_) => this.mcpClientManager.callTool(serverId, toolName, arguments_),
				sendCdpCommand: (id, method, parameters) => coordinatorStub.sendCdpCommand(id, method, parameters),
			};

			// Mutable copy of messages for the agent loop
			const workingMessages = [...messages];
			const currentRunStartIndex = workingMessages.length;

			let continueLoop = true;
			let iteration = 0;
			let hitIterationLimit = false;
			let lastAssistantText = '';
			let softLimitNudged = false;
			let planModeTodoNudged = false;

			while (continueLoop && iteration < MAX_ITERATIONS) {
				if (signal.aborted) {
					logger.info('agent_loop', 'aborted', { iteration });
					logger.markAborted();
					yield statusEvent('Interrupted');
					break;
				}

				iteration++;
				logger.setIteration(iteration);

				const estimatedTokens = estimateMessagesTokens(workingMessages);
				contextTokensUsed = estimatedTokens;
				const contextUtilization = getContextUtilization(workingMessages, modelLimits);
				yield contextUtilizationEvent(estimatedTokens, modelLimits.contextWindow, Math.round(contextUtilization * 100));
				yield statusEvent(this.mode === 'plan' ? 'Researching...' : 'Thinking...');

				// Soft iteration nudge
				if (iteration === SOFT_ITERATION_LIMIT && !softLimitNudged) {
					softLimitNudged = true;
					workingMessages.push({
						role: 'user',
						content: 'SYSTEM: You have been working for many iterations. Please try to wrap up the current task efficiently.',
					});
				}

				// Proactive pruning
				if (contextUtilization >= PROACTIVE_PRUNE_THRESHOLD) {
					const { messages: prunedMessages, prunedTokens } = pruneToolOutputs(workingMessages);
					if (prunedTokens > 0) {
						workingMessages.length = 0;
						workingMessages.push(...prunedMessages);
						const postPruneTokens = estimateMessagesTokens(workingMessages);
						const postPruneUtilization = getContextUtilization(workingMessages, modelLimits);
						yield contextUtilizationEvent(postPruneTokens, modelLimits.contextWindow, Math.round(postPruneUtilization * 100));
						yield statusEvent(`Pruned ${prunedTokens} tokens of old tool output`);
					}
				}

				// Context budget check
				if (!hasContextBudget(workingMessages, modelLimits)) {
					yield statusEvent('Context window exhausted');
					hitIterationLimit = true;
					break;
				}

				// Create tools for this iteration
				const changeCountBefore = queryChanges.length;
				const toolFailures: ToolFailureRecord[] = [];
				pendingToolCallIds.length = 0;
				const tools = createServerTools(
					sendEvent,
					toolContext,
					queryChanges,
					this.mode,
					logger,
					toolFailures,
					toolCallIdReference,
					pendingToolCallIds,
				);

				// ─── Call streamText() ───────────────────────────────────────
				let hadToolCalls = false;
				let hadUserQuestion = false;
				let hadMutationFailure = false;
				lastAssistantText = '';
				let retryAttempt = 0;
				const llmTimer = logger.startTimer();

				while (true) {
					let streamError: string | undefined;
					let caughtStreamError: unknown;

					try {
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- ToolSet generic variance; dynamically-built tools can't satisfy the strict generic
						const typedTools: Parameters<typeof streamText>[0]['tools'] = tools as any;
						const result = streamText({
							model: languageModel,
							messages: workingMessages,
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
									lastAssistantText += part.textDelta;
									yield textDeltaEvent(part.textDelta);
									break;
								}
								case 'reasoning-delta': {
									yield reasoningDeltaEvent(part.delta);
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
									const resultText = extractToolResultText(part.result);
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
														sessionId: this.sessionId ?? '',
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

									// Drain tool failures
									for (const failure of toolFailures) {
										if (MUTATION_TOOL_NAMES.has(failure.toolName)) {
											hadMutationFailure = true;
										}
										streamToolErrors.set(part.toolCallId, {
											toolCallId: part.toolCallId,
											toolName: failure.toolName,
											errorCode: failure.errorCode ?? '',
											errorMessage: failure.errorMessage,
										});
									}
									toolFailures.length = 0;
									break;
								}
								case 'finish': {
									if (part.usage) {
										tokenTracker.recordTurn(this.model, {
											inputTokens: part.usage.promptTokens,
											outputTokens: part.usage.completionTokens,
										});
										logger.recordTokenUsage(part.usage.promptTokens, part.usage.completionTokens);
										if (part.usage.promptTokens > 0) {
											yield contextUtilizationEvent(
												part.usage.promptTokens,
												modelLimits.contextWindow,
												Math.round((part.usage.promptTokens / (modelLimits.contextWindow - modelLimits.maxOutput)) * 100),
											);
										}
									}
									logger.info(
										'llm',
										'request_end',
										{
											finishReason: part.finishReason,
											inputTokens: part.usage?.promptTokens,
											outputTokens: part.usage?.completionTokens,
										},
										{ durationMs: llmTimer() },
									);
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
						workingMessages.push({
							role: 'user',
							content: `${MUTATION_FAILURE_TAG} SYSTEM: One or more mutation tools FAILED this turn. Before retrying, you MUST file_read the target file(s) to see their ACTUAL current content.`,
						});
					}

					// Plan mode todo nudge
					if (this.mode === 'plan' && !planModeTodoNudged && iteration > 1) {
						const currentTodos = await readTodos(this.projectRoot, this.sessionId);
						if (currentTodos.length === 0) {
							planModeTodoNudged = true;
							workingMessages.push({
								role: 'user',
								content: 'SYSTEM: You are in PLAN MODE. You MUST create a structured todo list using `todos_update`.',
							});
						}
					}
				} else {
					// No tool calls — text only, stop the loop
					if (lastAssistantText) {
						workingMessages.push({ role: 'assistant', content: lastAssistantText });
					}
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
								workingMessages.push({
									role: 'user',
									content: `SYSTEM: The IDE output panel shows new warnings or errors after your recent changes.\n\n<output_logs>\n${freshLogs}\n</output_logs>`,
								});
								yield statusEvent('Detected output errors, reviewing...');
							}
						}
					} catch {
						// Non-fatal
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

				if (hadUserQuestion) continueLoop = false;

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
				yield snapshotDeletedEvent(snapshotContext.id);
			}

			// Save plan in plan mode
			if (this.mode === 'plan' && lastAssistantText.trim()) {
				yield* savePlan(this.projectRoot, lastAssistantText, workingMessages);
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
			await logger.flush(this.projectRoot);
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				logger.markAborted();
				if (!sessionPersisted) await persistSession().catch(() => {});
				await logger.flush(this.projectRoot);
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
			await logger.flush(this.projectRoot);
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
				await logger.flush(this.projectRoot).catch(() => {});
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
}
