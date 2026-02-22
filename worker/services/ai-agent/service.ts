/**
 * AI Agent Service.
 * Handles the AI agent loop with streaming response using TanStack AI.
 *
 * Key architecture:
 * - Uses TanStack AI chat() with custom Replicate adapter for the agentic loop
 * - Emits native AG-UI protocol events via toServerSentEventsResponse()
 * - App-specific events (snapshots, file changes, etc.) are sent as CUSTOM AG-UI events
 * - Frontend uses useChat + fetchServerSentEvents to consume the stream natively
 * - Integrates retry, doom loop detection, context pruning, and token tracking
 */

import fs from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chat, maxIterations, StreamProcessor, toServerSentEventsResponse } from '@tanstack/ai';
import { mount, withMounts } from 'worker-fs-mount';

import {
	AGENT_SYSTEM_PROMPT,
	AGENTS_MD_MAX_CHARACTERS,
	ASK_MODE_SYSTEM_PROMPT,
	DEFAULT_AI_MODEL,
	MCP_SERVERS,
	PLAN_MODE_SYSTEM_PROMPT,
} from '@shared/constants';

import { AgentLogger, sanitizeToolInput, summarizeToolResult } from './agent-logger';
import { estimateMessagesTokens, getContextUtilization, hasContextBudget, pruneToolOutputs } from './context-pruner';
import { detectDoomLoop, MUTATION_FAILURE_TAG } from './doom-loop';
import { createAdapter, getModelLimits } from './replicate';
import { classifyRetryableError, calculateRetryDelay, sleep } from './retry';
import { TokenTracker } from './token-tracker';
import { createSendEvent, createServerTools, MUTATION_TOOL_NAMES } from './tools';
import { isRecordObject, parseApiError } from './utilities';
import { coordinatorNamespace } from '../../lib/durable-object-namespaces';

import type { CustomEventQueue, FileChange, ModelMessage, SnapshotMetadata, ToolExecutorContext, ToolFailureRecord } from './types';
import type { ExpiringFilesystem } from '../../durable/expiring-filesystem';
import type { AIModelId } from '@shared/constants';
import type { StreamChunk, UIMessage } from '@tanstack/ai';

// =============================================================================
// AG-UI Event Helpers
// =============================================================================

/**
 * Safely extract a string field from an unknown AG-UI event object.
 */
function getEventField(event: unknown, field: string): string | undefined {
	if (!isRecordObject(event)) return undefined;
	const value = event[field];
	return typeof value === 'string' ? value : undefined;
}

/**
 * Safely extract a record field from an unknown AG-UI event object.
 */
function getEventRecord(event: unknown, field: string): Record<string, unknown> | undefined {
	if (!isRecordObject(event)) return undefined;
	const value = event[field];
	return isRecordObject(value) ? value : undefined;
}

/**
 * Safely extract a number from a record by key.
 */
function getNumberField(record: Record<string, unknown>, field: string): number {
	const value = record[field];
	return typeof value === 'number' ? value : 0;
}

/**
 * Create a CUSTOM AG-UI event.
 */
function customEvent(name: string, data: Record<string, unknown>): StreamChunk {
	return { type: 'CUSTOM', name, data, timestamp: Date.now() };
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Hard ceiling on agent loop iterations — safety net to prevent runaway loops.
 * The agent will typically stop earlier due to context exhaustion or task completion.
 * This is intentionally generous since context-awareness and compaction handle the practical limits.
 */
const MAX_ITERATIONS = 200;

/** Maximum retry attempts for a single LLM call */
const MAX_RETRY_ATTEMPTS = 5;

/**
 * Soft iteration limit — when exceeded, the agent is nudged to wrap up.
 * The agent can still use tools after this point if context allows,
 * but we inject a message encouraging it to finish.
 */
const SOFT_ITERATION_LIMIT = 50;

/**
 * Context utilization threshold at which we proactively prune.
 * Pruning at 70% gives headroom before hitting the hard overflow limit.
 */
const PROACTIVE_PRUNE_THRESHOLD = 0.7;

/**
 * Minimum interval (ms) between incremental session saves during streaming.
 * Each `turn_complete` triggers a save, but this throttle prevents hammering
 * the filesystem on rapid successive turns.
 */
const SESSION_SAVE_THROTTLE_MS = 3000;

// =============================================================================
// AI Agent Service Class
// =============================================================================

export class AIAgentService {
	private mcpClients = new Map<string, Client>();

	constructor(
		private projectRoot: string,
		private projectId: string,
		private fsStub: DurableObjectStub<ExpiringFilesystem>,
		private sessionId?: string,
		private mode: 'code' | 'plan' | 'ask' = 'code',
		private model: AIModelId = DEFAULT_AI_MODEL,
	) {}

	/**
	 * Run the AI agent chat loop with streaming response.
	 * Returns a Response with AG-UI SSE events via toServerSentEventsResponse().
	 *
	 * The stream is "teed" through a server-side StreamProcessor that mirrors the
	 * client's UIMessage building. This enables the server to persist the session
	 * incrementally during streaming and on all termination paths (including client
	 * disconnect), producing UIMessage[] identical to what the client would build.
	 */
	async runAgentChat(
		messages: ModelMessage[],
		uiMessages: unknown[],
		apiKey: string,
		signal?: AbortSignal,
		outputLogs?: string,
	): Promise<Response> {
		const abortController = new AbortController();

		// Forward external signal to our controller
		if (signal) {
			signal.addEventListener('abort', () => abortController.abort(), { once: true });
		}

		// Server-side StreamProcessor mirrors the client's UIMessage building.
		// Initialized with the conversation history the client sent (UIMessage[]),
		// so the processor already contains all prior messages when the new
		// assistant message is appended during streaming.
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- wire format cast: uiMessages is UIMessage[] from the frontend
		const processor = new StreamProcessor({ initialMessages: uiMessages as UIMessage[] });

		// Run the agent loop in a mount scope (for worker-fs-mount)
		const innerStream = withMounts(() => {
			mount(this.projectRoot, this.fsStub);
			return this.createAgentStream(messages, apiKey, abortController, outputLogs);
		});

		// Tee the stream: feed chunks to both the SSE response and the server-side
		// StreamProcessor for session persistence.
		const teedStream = this.createTeedStream(innerStream, processor);

		return toServerSentEventsResponse(teedStream, { abortController });
	}

	/**
	 * Wraps the agent stream, mirroring every chunk to a server-side
	 * StreamProcessor and persisting the session on all termination paths.
	 *
	 * The generator propagates all chunks from the inner stream unchanged
	 * so the SSE response is identical. Additionally:
	 * - Feeds each chunk to the StreamProcessor to build UIMessage[]
	 * - Persists the session incrementally on `turn_complete` events
	 * - Persists the session in `finally` (handles client disconnect)
	 * - Tracks snapshot IDs and context token usage for session metadata
	 */
	private async *createTeedStream(innerStream: AsyncIterable<StreamChunk>, processor: StreamProcessor): AsyncIterable<StreamChunk> {
		processor.prepareAssistantMessage();

		// Snapshot ID emitted by the agent loop (set via snapshot_created CUSTOM event)
		let snapshotId: string | undefined;
		// Index of the user message that triggered this turn (last message before the assistant response)
		const userMessageIndex = processor.getMessages().length - 1;
		// Latest context token count from context_utilization CUSTOM events
		let contextTokensUsed = 0;
		// Throttle incremental saves
		let lastSaveTimestamp = 0;
		// Track whether the session was already persisted (idempotent guard for finally)
		let sessionPersisted = false;

		const persistSession = async () => {
			processor.finalizeStream();
			sessionPersisted = true;
			await this.persistSession(processor, snapshotId, userMessageIndex, contextTokensUsed);
		};

		try {
			for await (const chunk of innerStream) {
				// Mirror to the StreamProcessor for UIMessage building
				processor.processChunk(chunk);

				// Track metadata from CUSTOM events
				if (isRecordObject(chunk) && chunk.type === 'CUSTOM') {
					const name = typeof chunk.name === 'string' ? chunk.name : '';
					switch (name) {
						case 'snapshot_created': {
							const data = isRecordObject(chunk.data) ? chunk.data : {};
							const id = typeof data.id === 'string' ? data.id : undefined;
							if (id) snapshotId = id;

							break;
						}
						case 'context_utilization': {
							const data = isRecordObject(chunk.data) ? chunk.data : {};
							const tokens = typeof data.estimatedTokens === 'number' ? data.estimatedTokens : 0;
							if (tokens > 0) contextTokensUsed = tokens;

							break;
						}
						case 'turn_complete': {
							// Incrementally persist after each agent turn (throttled)
							const now = Date.now();
							if (now - lastSaveTimestamp >= SESSION_SAVE_THROTTLE_MS) {
								lastSaveTimestamp = now;
								await this.persistSession(processor, snapshotId, userMessageIndex, contextTokensUsed);
							}

							break;
						}
						// No default
					}
				}

				yield chunk;
			}

			// Normal completion — persist the final state
			await persistSession();
		} finally {
			// Safety net: if the stream was cancelled (client disconnect) or an
			// error occurred before the normal completion path, persist whatever
			// progress was made. The `finally` block runs even when the generator's
			// return() is invoked by ReadableStream cancel().
			if (!sessionPersisted) {
				await persistSession().catch(() => {});
			}
		}
	}

	/**
	 * Persist the current session state to disk.
	 *
	 * Writes the UIMessage[] from the StreamProcessor (which mirrors what the
	 * client would have built) to `.agent/sessions/{sessionId}.json`.
	 * Includes messageSnapshots and contextTokensUsed metadata.
	 *
	 * Non-fatal: errors are logged but never propagate to the caller.
	 */
	private async persistSession(
		processor: StreamProcessor,
		snapshotId: string | undefined,
		userMessageIndex: number,
		contextTokensUsed: number,
	): Promise<void> {
		if (!this.sessionId) return;

		try {
			const history = processor.getMessages();
			if (history.length === 0) return;

			// Derive label from the first user message
			const firstUserMessage = history.find((message) => message.role === 'user');
			let label = 'New chat';
			if (firstUserMessage) {
				const textParts = firstUserMessage.parts
					.filter((part): part is { type: 'text'; content: string } => part.type === 'text')
					.map((part) => part.content)
					.join(' ')
					.trim();
				label = textParts.length > 50 ? textParts.slice(0, 50) + '...' : textParts || 'New chat';
			}

			// Build messageSnapshots: associate the user message with the snapshot
			const messageSnapshots: Record<string, string> | undefined =
				snapshotId && userMessageIndex >= 0 ? { [String(userMessageIndex)]: snapshotId } : undefined;

			// Read the existing session's createdAt timestamp if available,
			// otherwise use the current time for new sessions.
			let createdAt = Date.now();
			const sessionPath = `${this.projectRoot}/.agent/sessions/${this.sessionId}.json`;
			try {
				const existing = await fs.readFile(sessionPath, 'utf8');
				const parsed: { createdAt?: number } = JSON.parse(existing);
				if (typeof parsed.createdAt === 'number') {
					createdAt = parsed.createdAt;
				}
			} catch {
				// New session or read error — use current timestamp
			}

			const session = {
				id: this.sessionId,
				label,
				createdAt,
				history,
				messageSnapshots,
				contextTokensUsed: contextTokensUsed > 0 ? contextTokensUsed : undefined,
			};

			const sessionsDirectory = `${this.projectRoot}/.agent/sessions`;
			await fs.mkdir(sessionsDirectory, { recursive: true });
			await fs.writeFile(sessionPath, JSON.stringify(session));
		} catch (error) {
			// Non-fatal — don't let session persistence break the agent stream
			console.error('Failed to persist AI session:', error);
		}
	}

	/**
	 * Get the filesystem stub for use in tool context.
	 */
	getFsStub(): DurableObjectStub<ExpiringFilesystem> {
		return this.fsStub;
	}

	/**
	 * Create the AG-UI event stream that wraps chat() with app-specific CUSTOM events.
	 *
	 * This async generator:
	 * 1. Emits CUSTOM status/snapshot events at the start
	 * 2. Runs the agent loop manually (chat() with maxIterations(1) per iteration)
	 * 3. Passes through AG-UI events from chat() directly to the client
	 * 4. Drains the CUSTOM event queue (populated by tool executors) between AG-UI events
	 * 5. Intercepts events for doom loop detection, file change tracking, token tracking
	 * 6. Emits CUSTOM usage/done events at the end
	 */
	private async *createAgentStream(
		messages: ModelMessage[],
		apiKey: string,
		abortController: AbortController,
		outputLogs?: string,
	): AsyncIterable<StreamChunk> {
		const signal = abortController.signal;
		const queryChanges: FileChange[] = [];
		const tokenTracker = new TokenTracker();
		const eventQueue: CustomEventQueue = [];
		const logger = new AgentLogger(this.sessionId, this.projectId, this.model, this.mode);

		logger.info('agent_loop', 'started', {
			mode: this.mode,
			model: this.model,
			sessionId: this.sessionId,
			messageCount: messages.length,
			maxIterations: MAX_ITERATIONS,
			softLimit: SOFT_ITERATION_LIMIT,
		});

		// Create the sendEvent function that pushes CUSTOM events to the queue
		const sendEvent = createSendEvent(eventQueue);

		// Eagerly create a snapshot directory for code mode
		let snapshotContext: { id: string; directory: string; savedPaths: Set<string> } | undefined;
		if (this.mode === 'code') {
			snapshotContext = await this.initSnapshot(messages, sendEvent);
			logger.debug('snapshot', 'created', { snapshotId: snapshotContext.id });
			// Drain snapshot events
			while (eventQueue.length > 0) {
				const queued = eventQueue.shift();
				if (queued) yield queued;
			}
		}

		// Create coordinator stub before try-catch so it's accessible in error handlers
		const coordinatorId = coordinatorNamespace.idFromName(`project:${this.projectId}`);
		const coordinatorStub = coordinatorNamespace.get(coordinatorId);

		try {
			yield customEvent('status', { message: 'Starting...' });

			// Build system prompts
			const systemPrompts = await this.buildSystemPrompts(outputLogs);
			logger.debug('message', 'system_prompt_built', {
				promptCount: systemPrompts.length,
				totalLength: systemPrompts.reduce((sum, p) => sum + p.length, 0),
			});

			// Create the Replicate adapter
			const adapter = createAdapter(this.model, apiKey, logger);
			const modelLimits = getModelLimits(this.model);
			const toolContext: ToolExecutorContext = {
				projectRoot: this.projectRoot,
				projectId: this.projectId,
				mode: this.mode,
				sessionId: this.sessionId,
				callMcpTool: (serverId, toolName, arguments_) => this.callMcpTool(serverId, toolName, arguments_),
				sendCdpCommand: (id, method, parameters) => coordinatorStub.sendCdpCommand(id, method, parameters),
			};

			// Mutable copy of messages for the agent loop
			const workingMessages = [...messages];

			let continueLoop = true;
			let iteration = 0;
			let hitIterationLimit = false;
			let lastAssistantText = '';
			let xmlRetried = false;
			let softLimitNudged = false;

			while (continueLoop && iteration < MAX_ITERATIONS) {
				if (signal.aborted) {
					logger.info('agent_loop', 'aborted', { iteration });
					logger.markAborted();
					yield customEvent('status', { message: 'Interrupted' });
					break;
				}

				iteration++;
				logger.setIteration(iteration);

				const estimatedTokens = estimateMessagesTokens(workingMessages);
				const contextUtilization = getContextUtilization(workingMessages, modelLimits);
				logger.info('agent_loop', 'iteration_start', {
					iteration,
					workingMessageCount: workingMessages.length,
					contextUtilization: Math.round(contextUtilization * 100),
					estimatedTokens,
				});
				// Emit context utilization so the frontend ring updates in real-time
				yield customEvent('context_utilization', {
					estimatedTokens,
					contextWindow: modelLimits.contextWindow,
					utilization: Math.round(contextUtilization * 100),
				});
				yield customEvent('status', {
					message: this.mode === 'plan' ? 'Researching...' : 'Thinking...',
				});

				// Soft iteration nudge — encourage the agent to wrap up after SOFT_ITERATION_LIMIT
				if (iteration === SOFT_ITERATION_LIMIT && !softLimitNudged) {
					softLimitNudged = true;
					logger.info('agent_loop', 'soft_limit_nudge', { iteration });
					workingMessages.push({
						role: 'user',
						content:
							'SYSTEM: You have been working for many iterations. ' +
							'Please try to wrap up the current task efficiently. ' +
							'If you are close to finishing, continue. ' +
							'If you are stuck in a loop, stop and explain what you need.',
					});
				}

				// Proactive pruning — prune early (at 70% utilization) to avoid hitting the wall
				if (contextUtilization >= PROACTIVE_PRUNE_THRESHOLD) {
					const { messages: prunedMessages, prunedTokens } = pruneToolOutputs(workingMessages);
					if (prunedTokens > 0) {
						logger.info('context', 'proactive_prune', {
							prunedTokens,
							contextUtilization: Math.round(contextUtilization * 100),
							messageCountBefore: workingMessages.length,
							messageCountAfter: prunedMessages.length,
						});
						workingMessages.length = 0;
						workingMessages.push(...prunedMessages);
						// Update context utilization after pruning
						const postPruneTokens = estimateMessagesTokens(workingMessages);
						const postPruneUtilization = getContextUtilization(workingMessages, modelLimits);
						yield customEvent('context_utilization', {
							estimatedTokens: postPruneTokens,
							contextWindow: modelLimits.contextWindow,
							utilization: Math.round(postPruneUtilization * 100),
						});
						yield customEvent('status', {
							message: `Pruned ${prunedTokens} tokens of old tool output`,
						});
					}
				}

				// Context budget check — if still overflowing after pruning, stop
				if (!hasContextBudget(workingMessages, modelLimits)) {
					logger.warn('context', 'no_budget_remaining', {
						estimatedTokens: estimateMessagesTokens(workingMessages),
					});
					yield customEvent('status', { message: 'Context window exhausted' });
					hitIterationLimit = true;
					break;
				}

				// Track file changes before this iteration for snapshot
				const changeCountBefore = queryChanges.length;

				// Create tools fresh each iteration (they capture the mutable queryChanges array)
				const toolFailures: ToolFailureRecord[] = [];
				const tools = createServerTools(sendEvent, toolContext, queryChanges, this.mode, logger, toolFailures);

				// Call the LLM with retry
				let chatResult: AsyncIterable<StreamChunk>;
				let retryAttempt = 0;
				let llmTimer = logger.startTimer();

				logger.info('llm', 'request_start', {
					model: this.model,
					maxTokens: 8192,
					toolCount: tools.length,
				});

				while (true) {
					try {
						llmTimer = logger.startTimer();
						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack AI message types are restrictive
						const messagesCopy: any = [...workingMessages];
						chatResult = chat({
							adapter,
							messages: messagesCopy,
							systemPrompts,
							tools,
							maxTokens: 8192,
							agentLoopStrategy: maxIterations(1),
						});
						break;
					} catch (error) {
						retryAttempt++;
						const retryReason = classifyRetryableError(error);
						if (!retryReason || retryAttempt >= MAX_RETRY_ATTEMPTS) {
							logger.error('llm', 'request_failed', {
								retryAttempt,
								reason: retryReason ?? 'non_retryable',
								error: error instanceof Error ? error.message : String(error),
							});
							throw error;
						}
						const delay = calculateRetryDelay(retryAttempt, error);
						logger.warn('llm', 'retry', {
							retryAttempt,
							reason: retryReason,
							delayMs: delay,
						});
						yield customEvent('status', { message: `Retrying (${retryReason})...` });
						await sleep(delay, signal);
					}
				}

				// Consume the AG-UI event stream from chat()
				let hadToolCalls = false;
				let hadUserQuestion = false;
				let hadMutationFailure = false;
				let currentToolCallId: string | undefined;
				let currentToolName: string | undefined;
				let currentToolArguments = '';
				const completedToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
				const toolResults: Array<{ toolCallId: string; content: string }> = [];

				// Track tool call arguments by ID for the TOOL_CALL_END dual-role handling.
				// TanStack AI emits two TOOL_CALL_END events per tool call:
				// 1. From adapter (no result): signals arguments are finalized
				// 2. From executeToolCalls (with result): signals execution is done
				// We need the args from event #1 when processing event #2.
				const toolCallArgumentsById = new Map<string, { name: string; arguments: string; input: Record<string, unknown> }>();

				for await (const chunk of chatResult) {
					if (signal.aborted) break;

					// Drain any CUSTOM events queued by tool executors
					while (eventQueue.length > 0) {
						const queued = eventQueue.shift();
						if (queued) yield queued;
					}

					if (!isRecordObject(chunk)) continue;
					const eventType = getEventField(chunk, 'type');

					switch (eventType) {
						case 'TEXT_MESSAGE_CONTENT': {
							const delta = getEventField(chunk, 'delta');
							if (delta) {
								lastAssistantText += delta;
							}
							// Pass through to client
							yield chunk;
							break;
						}
						case 'TEXT_MESSAGE_START': {
							lastAssistantText = '';
							yield chunk;
							break;
						}
						case 'TEXT_MESSAGE_END': {
							yield chunk;
							break;
						}
						case 'TOOL_CALL_START': {
							hadToolCalls = true;
							currentToolCallId = getEventField(chunk, 'toolCallId');
							currentToolName = getEventField(chunk, 'toolName');
							currentToolArguments = '';
							logger.debug('tool_call', 'stream_start', {
								toolCallId: currentToolCallId,
								toolName: currentToolName,
							});
							yield chunk;
							break;
						}
						case 'TOOL_CALL_ARGS': {
							currentToolArguments += getEventField(chunk, 'delta') ?? '';
							yield chunk;
							break;
						}
						case 'TOOL_CALL_END': {
							const toolCallId = getEventField(chunk, 'toolCallId') || currentToolCallId || '';
							const toolName = getEventField(chunk, 'toolName') || currentToolName;
							const resultContent = getEventField(chunk, 'result');
							const hasResult = resultContent !== undefined && resultContent !== '';

							if (hasResult) {
								// Phase 2: TanStack AI signals tool execution is done (has result).
								// Look up the stored args from phase 1.
								const stored = toolCallArgumentsById.get(toolCallId);
								const resolvedName = toolName || stored?.name || 'unknown';
								const resolvedArguments = stored?.arguments ?? '';
								const resolvedInput = stored?.input ?? {};

								// Add to completedToolCalls for message reconstruction
								completedToolCalls.push({ id: toolCallId, name: resolvedName, arguments: resolvedArguments });
								toolResults.push({ toolCallId, content: resultContent });

								logger.info('tool_call', 'execution_result', {
									toolCallId,
									toolName: resolvedName,
									input: sanitizeToolInput(resolvedInput),
									resultSummary: summarizeToolResult(resultContent),
									resultLength: resultContent.length,
								});

								// Drain typed failure records from the tool executor.
								// Emit CUSTOM events so the frontend gets structured error data
								// instead of having to regex-parse "[CODE] message" prefixes.
								for (const failure of toolFailures) {
									if (MUTATION_TOOL_NAMES.has(failure.toolName)) {
										hadMutationFailure = true;
									}
									yield customEvent('tool_error', {
										toolCallId,
										toolName: failure.toolName,
										errorCode: failure.errorCode ?? '',
										errorMessage: failure.errorMessage,
									});
								}
								toolFailures.length = 0;

								// Clean up stored args
								toolCallArgumentsById.delete(toolCallId);
							} else {
								// Phase 1: Adapter signals arguments are finalized (no result yet).
								// Parse and store args, record for doom detection, but don't add
								// to completedToolCalls yet — wait for the execution result.
								let toolInput: Record<string, unknown> = {};
								if (toolName) {
									try {
										toolInput = JSON.parse(currentToolArguments || '{}');
									} catch {
										logger.warn('tool_call', 'arguments_parse_error', {
											toolCallId,
											toolName,
											rawArguments: currentToolArguments.slice(0, 200),
										});
									}
									logger.recordToolCall(toolName);
								}

								// Store args for phase 2 lookup
								if (toolCallId) {
									toolCallArgumentsById.set(toolCallId, {
										name: toolName ?? 'unknown',
										arguments: currentToolArguments,
										input: toolInput,
									});
								}

								logger.info('tool_call', 'args_complete', {
									toolCallId,
									toolName,
									input: sanitizeToolInput(toolInput),
								});

								// Reset streaming state (args accumulation is done)
								currentToolCallId = undefined;
								currentToolName = undefined;
								currentToolArguments = '';
							}

							// Check if user_question was used — stop the loop
							if (toolName === 'user_question') {
								logger.info('agent_loop', 'user_question_stop', { toolCallId });
								hadUserQuestion = true;
							}

							yield chunk;

							// Drain any CUSTOM events from tool execution
							while (eventQueue.length > 0) {
								const queued = eventQueue.shift();
								if (queued) yield queued;
							}

							break;
						}
						case 'RUN_FINISHED': {
							// Extract usage data if available
							const usage = getEventRecord(chunk, 'usage');
							const finishReason = getEventField(chunk, 'finishReason');
							const inputTokens = usage ? getNumberField(usage, 'inputTokens') || getNumberField(usage, 'input_tokens') : 0;
							const outputTokens = usage ? getNumberField(usage, 'outputTokens') || getNumberField(usage, 'output_tokens') : 0;
							if (usage) {
								tokenTracker.recordTurn(this.model, {
									inputTokens,
									outputTokens,
									cacheReadInputTokens: getNumberField(usage, 'cacheReadInputTokens') || getNumberField(usage, 'cache_read_input_tokens'),
									cacheCreationInputTokens:
										getNumberField(usage, 'cacheCreationInputTokens') || getNumberField(usage, 'cache_creation_input_tokens'),
								});
								logger.recordTokenUsage(inputTokens, outputTokens);
								// Emit real-time context utilization with API-reported token count
								if (inputTokens > 0) {
									yield customEvent('context_utilization', {
										estimatedTokens: inputTokens,
										contextWindow: modelLimits.contextWindow,
										utilization: Math.round((inputTokens / (modelLimits.contextWindow - modelLimits.maxOutput)) * 100),
									});
								}
							}
							logger.info(
								'llm',
								'request_end',
								{
									finishReason,
									inputTokens,
									outputTokens,
									toolCallCount: completedToolCalls.length,
									textLength: lastAssistantText.length,
									// Include a truncated snippet of the raw output for debugging.
									// Especially useful when toolCallCount is 0 (model didn't call tools).
									outputSnippet: lastAssistantText.slice(0, 500),
								},
								{ durationMs: llmTimer() },
							);
							// Pass through — this is the per-iteration RUN_FINISHED
							yield chunk;
							break;
						}
						case 'RUN_ERROR': {
							const errorData = getEventRecord(chunk, 'error');
							logger.error('llm', 'stream_error', {
								message: errorData ? getEventField(errorData, 'message') : 'Unknown error',
							});
							// Pass through — retries are handled at the outer chat() call level,
							// not inside the stream consumption loop.
							yield chunk;
							break;
						}
						default: {
							// Pass through other AG-UI events (RUN_STARTED, STEP_STARTED, etc.)
							yield chunk;
							break;
						}
					}
				}

				// Drain any remaining CUSTOM events from the last tool execution
				while (eventQueue.length > 0) {
					const queued = eventQueue.shift();
					if (queued) yield queued;
				}

				// Incrementally persist new file changes to the snapshot
				if (snapshotContext && queryChanges.length > changeCountBefore) {
					for (let index = changeCountBefore; index < queryChanges.length; index++) {
						await this.addFileToSnapshot(snapshotContext, queryChanges[index]);
					}
				}

				// Update messages for next iteration.
				// When tool calls occurred, reconstruct the full assistant + tool result
				// messages so the LLM sees the complete context on the next iteration.
				if (hadToolCalls && completedToolCalls.length > 0) {
					logger.debug('message', 'messages_reconstructed', {
						toolCallCount: completedToolCalls.length,
						toolNames: completedToolCalls.map((tc) => tc.name),
						textLength: lastAssistantText.length,
						mutationCount: completedToolCalls.filter((tc) => MUTATION_TOOL_NAMES.has(tc.name)).length,
					});
					workingMessages.push({
						role: 'assistant',
						// eslint-disable-next-line unicorn/no-null -- ModelMessage.content requires null, not undefined
						content: lastAssistantText || null,
						toolCalls: completedToolCalls.map((tc) => ({
							id: tc.id,
							type: 'function' as const,
							function: { name: tc.name, arguments: tc.arguments },
						})),
					});
					for (const result of toolResults) {
						workingMessages.push({
							role: 'tool',
							content: result.content,
							toolCallId: result.toolCallId,
						});
					}

					// Inject a corrective message when mutation tools failed.
					// This teaches the LLM to re-read files before retrying.
					if (hadMutationFailure) {
						logger.info('agent_loop', 'mutation_failure_correction', {
							iteration,
						});
						workingMessages.push({
							role: 'user',
							content:
								`${MUTATION_FAILURE_TAG} SYSTEM: One or more mutation tools (file_edit, file_write, etc.) FAILED this turn. ` +
								'Common causes: (1) the patch contained content that does not match the actual file — you may be hallucinating file contents; ' +
								'(2) the old_string in file_edit does not exist in the file. ' +
								'CRITICAL INSTRUCTION: Before retrying, you MUST file_read the target file(s) to see their ACTUAL current content. ' +
								'Do NOT guess what a file contains — read it first.',
						});
					}

					completedToolCalls.length = 0;
					toolResults.length = 0;
				} else {
					if (lastAssistantText) {
						workingMessages.push({ role: 'assistant', content: lastAssistantText });
					}

					// Detect XML output that looks like failed tool calls.
					// Some models emit tool calls as XML text instead of using the
					// tool-calling API. When detected, inject a corrective message
					// and retry once so the model uses proper tool calls.
					const xmlToolCallPattern = /<(?:function_calls|invoke\s|tool_use|tool_call|antml:invoke)/;
					const containsXmlToolCalls = xmlToolCallPattern.test(lastAssistantText);

					if (containsXmlToolCalls && !xmlRetried) {
						xmlRetried = true;
						logger.warn('agent_loop', 'xml_tool_call_detected', {
							outputSnippet: lastAssistantText.slice(0, 500),
						});
						yield customEvent('status', {
							message: 'Detected XML tool output — retrying with proper tool calls...',
						});
						workingMessages.push({
							role: 'user',
							content:
								'SYSTEM: Your previous response contained XML-formatted tool calls (e.g. <function_calls>, <invoke>, <tool_use>) as plain text. ' +
								'CRITICAL INSTRUCTION: You MUST use the tool-calling API provided to you, not XML tags. ' +
								'Please retry your intended action using the actual tool functions available to you. ' +
								'Do NOT output XML tags. Call the tools directly.',
						});
						// Continue the loop — the model will retry with proper tool calls
					} else {
						logger.info('agent_loop', 'no_tool_calls_stop', {
							textLength: lastAssistantText.length,
							outputSnippet: lastAssistantText.slice(0, 500),
							containsXmlToolCalls,
						});
						continueLoop = false;
					}
				}

				// Proactively check for new errors/warnings in the IDE output.
				// After file mutations, the preview rebuilds and may produce new errors.
				// The frontend pushes fresh output logs to the coordinator via WebSocket.
				// If new errors appeared, inject a system message so the agent can react.
				const fileChangesThisIteration = queryChanges.length - changeCountBefore;
				if (continueLoop && fileChangesThisIteration > 0) {
					try {
						// Brief delay to let HMR rebuild and the frontend sync logs
						await sleep(2000, signal);
						const freshLogs = await coordinatorStub.getOutputLogs();
						if (freshLogs && freshLogs !== (outputLogs ?? '')) {
							// Check if the fresh logs contain errors or warnings
							const hasErrors = /\bERROR:/i.test(freshLogs) || /\bWARNING:/i.test(freshLogs);
							if (hasErrors) {
								logger.info('agent_loop', 'output_errors_detected', {
									logsLength: freshLogs.length,
								});
								workingMessages.push({
									role: 'user',
									content:
										'SYSTEM: The IDE output panel shows new warnings or errors after your recent changes. ' +
										'Review them carefully and fix any issues before proceeding.\n\n' +
										`<output_logs>\n${freshLogs}\n</output_logs>`,
								});
								yield customEvent('status', { message: 'Detected output errors, reviewing...' });
							}
						}
					} catch {
						// Non-fatal — coordinator may be unreachable
					}
				}
				const loopResult = detectDoomLoop(workingMessages);
				if (loopResult.isDoomLoop) {
					logger.warn('agent_loop', 'doom_loop_detected', {
						reason: loopResult.reason,
						toolName: loopResult.toolName,
					});
					logger.markDoomLoop();
					yield customEvent('status', {
						message: loopResult.toolName ? `${loopResult.toolName} loop detected, stopping.` : 'Doom loop detected, stopping.',
					});
					yield customEvent('doom_loop_detected', {
						reason: loopResult.reason || 'unknown',
						toolName: loopResult.toolName,
						message: loopResult.message || 'The agent was stopped to prevent an infinite loop.',
					});
					continueLoop = false;
				}

				// Check user question
				if (hadUserQuestion) {
					continueLoop = false;
				}

				// If no tool calls, we're done
				if (!hadToolCalls) {
					continueLoop = false;
				}

				logger.info('agent_loop', 'iteration_end', {
					iteration,
					hadToolCalls,
					hadUserQuestion,
					continueLoop,
					fileChangesThisIteration,
				});

				yield customEvent('turn_complete', {});
			}

			// Detect iteration limit hit (hard ceiling or context exhaustion — hitIterationLimit
			// may already be true if the loop broke due to context budget exhaustion)
			if (!hitIterationLimit && continueLoop && iteration >= MAX_ITERATIONS && !signal.aborted) {
				hitIterationLimit = true;
			}
			if (hitIterationLimit) {
				logger.warn('agent_loop', 'iteration_limit', {
					maxIterations: MAX_ITERATIONS,
					actualIterations: iteration,
					reason: iteration >= MAX_ITERATIONS ? 'hard_ceiling' : 'context_exhausted',
				});
				logger.markIterationLimit();
			}

			// Clean up empty snapshots
			if (snapshotContext && queryChanges.length === 0) {
				await this.deleteDirectoryRecursive(snapshotContext.directory);
			}

			// In plan mode, save the plan
			if (this.mode === 'plan' && lastAssistantText.trim()) {
				yield* this.savePlan(lastAssistantText, workingMessages);
			}

			if (hitIterationLimit) {
				yield customEvent('max_iterations_reached', { iterations: iteration });
			}

			// Emit token usage summary
			const totalUsage = tokenTracker.getTotalUsage();
			if (totalUsage.input > 0 || totalUsage.output > 0) {
				// The last turn's input tokens reflect the current context window
				// utilization (the full conversation size sent to the model).
				const turns = tokenTracker.getTurns();
				const lastTurn = turns.at(-1);
				const lastTurnInput = lastTurn ? lastTurn.usage.input : 0;
				yield customEvent('usage', {
					input: totalUsage.input,
					output: totalUsage.output,
					cacheRead: totalUsage.cacheRead,
					cacheWrite: totalUsage.cacheWrite,
					turns: tokenTracker.turnCount,
					lastTurnInputTokens: lastTurnInput,
				});
			}

			// Log completion and flush
			logger.info('agent_loop', 'completed', {
				totalIterations: iteration,
				totalFileChanges: queryChanges.length,
				hitIterationLimit,
			});
			await logger.flush(this.projectRoot);
			await this.broadcastDebugLogReady(coordinatorStub, logger.id);
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				logger.info('agent_loop', 'aborted');
				logger.markAborted();
				await logger.flush(this.projectRoot);
				if (snapshotContext && queryChanges.length === 0) {
					try {
						await this.deleteDirectoryRecursive(snapshotContext.directory);
					} catch {
						// No-op
					}
				}
				await this.broadcastDebugLogReady(coordinatorStub, logger.id);
				return;
			}
			console.error('Agent loop error:', error);
			logger.error('agent_loop', 'error', {
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			// Flush and broadcast BEFORE yielding the error event.
			// The yield can throw if the stream consumer has already disconnected,
			// which would skip everything after it. Persisting the debug log is
			// more important than delivering the SSE error event.
			await logger.flush(this.projectRoot);
			if (snapshotContext && queryChanges.length === 0) {
				try {
					await this.deleteDirectoryRecursive(snapshotContext.directory);
				} catch {
					// No-op
				}
			}
			await this.broadcastDebugLogReady(coordinatorStub, logger.id);
			const parsed = parseApiError(error);
			yield {
				type: 'RUN_ERROR',
				timestamp: Date.now(),
				error: { message: parsed.message, code: parsed.code ?? undefined },
			};
		} finally {
			// When the SSE consumer stops iterating (e.g., client disconnects and
			// the ReadableStream is cancelled), the generator's return() is invoked
			// which skips both the try-block completion path and the catch block —
			// only this finally block runs. Ensure the debug log is still flushed
			// and broadcast so the download button appears on the frontend.
			//
			// flush() is idempotent — if it already succeeded in the try/catch
			// paths above, this is a no-op. If the previous flush failed (e.g.,
			// filesystem error), the idempotency flag was reset and this retries.
			if (!logger.isFlushed) {
				logger.info('agent_loop', 'aborted');
				logger.markAborted();
				await logger.flush(this.projectRoot).catch(() => {});
				if (snapshotContext && queryChanges.length === 0) {
					try {
						await this.deleteDirectoryRecursive(snapshotContext.directory);
					} catch {
						// No-op
					}
				}
				await this.broadcastDebugLogReady(coordinatorStub, logger.id);
			}
			await this.closeMcpClients();
		}
	}

	// =============================================================================
	// Debug Log Broadcasting
	// =============================================================================

	/**
	 * Broadcast a debug-log-ready message to all connected clients via the
	 * project coordinator WebSocket. This replaces the previous approach of
	 * emitting the debug_log ID as a CUSTOM AG-UI SSE event, ensuring the
	 * notification arrives even when the SSE stream is interrupted (cancel/error).
	 */
	private async broadcastDebugLogReady(
		coordinatorStub: DurableObjectStub<import('../../durable/project-coordinator').ProjectCoordinator>,
		logId: string,
	): Promise<void> {
		try {
			await coordinatorStub.sendMessage({
				type: 'debug-log-ready',
				id: logId,
				sessionId: this.sessionId ?? '',
			});
		} catch {
			// Non-fatal — don't let notification failures break the agent
		}
	}

	// =============================================================================
	// System Prompt Builder
	// =============================================================================

	private async buildSystemPrompts(outputLogs?: string): Promise<string[]> {
		const prompts: string[] = [];

		let mainPrompt = AGENT_SYSTEM_PROMPT;

		// Add AGENTS.md context
		const agentsContext = await this.readAgentsContext();
		if (agentsContext) {
			mainPrompt += `\n\n## Project Guidelines (from AGENTS.md)\n${agentsContext}`;
		}

		// Add mode-specific addendum
		if (this.mode === 'plan') {
			mainPrompt += PLAN_MODE_SYSTEM_PROMPT;
		} else if (this.mode === 'ask') {
			mainPrompt += ASK_MODE_SYSTEM_PROMPT;
		}

		// Add latest plan context (in code mode only)
		if (this.mode !== 'plan') {
			const latestPlan = await this.readLatestPlan();
			if (latestPlan) {
				mainPrompt += `\n\n## Active Implementation Plan\nFollow this plan for all implementation steps. Reference it to decide what to do next and mark steps as complete when done.\n\n${latestPlan}`;
			}
		}

		// Append IDE output logs (bundle errors, server logs, client console, lint)
		if (outputLogs && outputLogs.trim().length > 0) {
			mainPrompt += `\n\n## IDE Output Logs\nThe following are recent output messages from the IDE (bundle errors, server logs, client console logs, lint diagnostics). Use these to diagnose issues the user may be experiencing.\n\n<output_logs>\n${outputLogs}\n</output_logs>`;
		}

		prompts.push(mainPrompt);
		return prompts;
	}

	// =============================================================================
	// Snapshot Management
	// =============================================================================

	private async initSnapshot(
		messages: ModelMessage[],
		sendEvent: (type: string, data: Record<string, unknown>) => void,
	): Promise<{ id: string; directory: string; savedPaths: Set<string> }> {
		const snapshotId = crypto.randomUUID().slice(0, 8);
		const snapshotDirectory = `${this.projectRoot}/.agent/snapshots/${snapshotId}`;

		await fs.mkdir(snapshotDirectory, { recursive: true });

		// Derive label from the last user message
		const lastUserMessage = [...messages].toReversed().find((m) => m.role === 'user');
		const promptText = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
		const label = promptText.slice(0, 50) + (promptText.length > 50 ? '...' : '');

		const metadata: SnapshotMetadata = {
			id: snapshotId,
			timestamp: Date.now(),
			label,
			changes: [],
		};
		// eslint-disable-next-line unicorn/no-null -- JSON.stringify requires null as replacer argument
		await fs.writeFile(`${snapshotDirectory}/metadata.json`, JSON.stringify(metadata, null, 2));

		await this.cleanupOldSnapshots(10);

		sendEvent('snapshot_created', {
			id: snapshotId,
			label: metadata.label,
			timestamp: metadata.timestamp,
			changes: [],
		});

		return { id: snapshotId, directory: snapshotDirectory, savedPaths: new Set() };
	}

	private async addFileToSnapshot(context: { id: string; directory: string; savedPaths: Set<string> }, change: FileChange): Promise<void> {
		if (context.savedPaths.has(change.path)) return;
		context.savedPaths.add(change.path);

		if (change.action !== 'create' && change.beforeContent !== null) {
			const filePath = `${context.directory}${change.path}`;
			const directory = filePath.slice(0, filePath.lastIndexOf('/'));
			if (directory && directory !== context.directory) {
				await fs.mkdir(directory, { recursive: true });
			}
			await fs.writeFile(filePath, change.beforeContent);
		}

		try {
			const metadataPath = `${context.directory}/metadata.json`;
			const raw = await fs.readFile(metadataPath, 'utf8');
			const metadata: SnapshotMetadata = JSON.parse(raw);
			metadata.changes.push({ path: change.path, action: change.action });
			// eslint-disable-next-line unicorn/no-null -- JSON.stringify requires null as replacer argument
			await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
		} catch {
			// Non-fatal
		}
	}

	private async cleanupOldSnapshots(keepCount: number): Promise<void> {
		const snapshotsDirectory = `${this.projectRoot}/.agent/snapshots`;

		try {
			const entries = await fs.readdir(snapshotsDirectory);
			const snapshots: Array<{ id: string; timestamp: number }> = [];

			for (const entry of entries) {
				try {
					const metadataPath = `${snapshotsDirectory}/${entry}/metadata.json`;
					const metadataRaw = await fs.readFile(metadataPath, 'utf8');
					const metadata: SnapshotMetadata = JSON.parse(metadataRaw);
					snapshots.push({ id: entry, timestamp: metadata.timestamp });
				} catch {
					// No-op
				}
			}

			snapshots.sort((a, b) => b.timestamp - a.timestamp);

			for (let index = keepCount; index < snapshots.length; index++) {
				await this.deleteDirectoryRecursive(`${snapshotsDirectory}/${snapshots[index].id}`);
			}
		} catch {
			// No-op
		}
	}

	private async deleteDirectoryRecursive(directoryPath: string): Promise<void> {
		try {
			const entries = await fs.readdir(directoryPath, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = `${directoryPath}/${entry.name}`;
				await (entry.isDirectory() ? this.deleteDirectoryRecursive(fullPath) : fs.unlink(fullPath));
			}
			await fs.rmdir(directoryPath);
		} catch {
			// No-op
		}
	}

	// =============================================================================
	// AGENTS.md Context
	// =============================================================================

	private async readAgentsContext(): Promise<string | undefined> {
		try {
			const entries = await fs.readdir(this.projectRoot);
			const agentsFile = entries.find((entry) => entry.toLowerCase() === 'agents.md');
			if (!agentsFile) return undefined;

			let content = await fs.readFile(`${this.projectRoot}/${agentsFile}`, 'utf8');
			if (content.length > AGENTS_MD_MAX_CHARACTERS) {
				content = content.slice(0, AGENTS_MD_MAX_CHARACTERS) + '\n...(truncated)';
			}
			return content;
		} catch {
			return undefined;
		}
	}

	// =============================================================================
	// Plan Context
	// =============================================================================

	private async readLatestPlan(): Promise<string | undefined> {
		try {
			const plansDirectory = `${this.projectRoot}/.agent/plans`;
			const entries = await fs.readdir(plansDirectory);
			const planFiles = entries.filter((entry) => entry.endsWith('-plan.md')).toSorted();
			if (planFiles.length === 0) return undefined;

			const latestFile = planFiles.at(-1);
			if (!latestFile) return undefined;

			const content = await fs.readFile(`${plansDirectory}/${latestFile}`, 'utf8');
			if (!content.trim()) return undefined;

			return content;
		} catch {
			return undefined;
		}
	}

	// =============================================================================
	// Plan Mode
	// =============================================================================

	private async *savePlan(planContent: string, messages: ModelMessage[]): AsyncIterable<StreamChunk> {
		try {
			const plansDirectory = `${this.projectRoot}/.agent/plans`;
			await fs.mkdir(plansDirectory, { recursive: true });

			const timestamp = Date.now();
			const planFileName = `${timestamp}-plan.md`;
			const planPath = `${plansDirectory}/${planFileName}`;

			// Derive prompt text from the first user message
			const firstUserMessage = messages.find((m) => m.role === 'user');
			const promptText = typeof firstUserMessage?.content === 'string' ? firstUserMessage.content : '';
			const header = `# Plan: ${promptText.slice(0, 80)}${promptText.length > 80 ? '...' : ''}\n\n_Generated at ${new Date(timestamp).toISOString()}_\n\n---\n\n`;
			await fs.writeFile(planPath, header + planContent);

			yield customEvent('plan_created', {
				path: `/.agent/plans/${planFileName}`,
				content: planContent,
			});
		} catch (error) {
			console.error('Failed to save plan:', error);
		}
	}

	// =============================================================================
	// MCP Client
	// =============================================================================

	private async getMcpClient(serverId: string): Promise<Client> {
		const existing = this.mcpClients.get(serverId);
		if (existing) return existing;

		const serverConfig = MCP_SERVERS.find((server) => server.id === serverId);
		if (!serverConfig) {
			throw new Error(`Unknown MCP server: ${serverId}`);
		}

		const client = new Client({ name: 'worker-ide-agent', version: '1.0.0' });
		const transport = new StreamableHTTPClientTransport(new URL(serverConfig.endpoint));
		await client.connect(transport);

		this.mcpClients.set(serverId, client);
		return client;
	}

	private async callMcpTool(serverId: string, toolName: string, arguments_: Record<string, unknown>): Promise<string> {
		const client = await this.getMcpClient(serverId);
		const result = await client.callTool({ name: toolName, arguments: arguments_ });

		if (result.content && Array.isArray(result.content)) {
			const textParts: string[] = [];
			for (const item of result.content) {
				if (isRecordObject(item) && item.type === 'text' && typeof item.text === 'string') {
					textParts.push(item.text);
				}
			}
			if (textParts.length > 0) {
				return textParts.join('\n');
			}
		}

		return JSON.stringify(result.content);
	}

	private async closeMcpClients(): Promise<void> {
		for (const [serverId, client] of this.mcpClients) {
			try {
				await client.close();
			} catch {
				// No-op
			}
			this.mcpClients.delete(serverId);
		}
	}
}
