/**
 * AI Agent Service.
 *
 * Orchestrates the AI agent loop with streaming response using TanStack AI.
 *
 * Key architecture:
 * - Uses TanStack AI chat() with provider-specific adapters for the agent loop
 * - Emits native AG-UI protocol events via toServerSentEventsResponse()
 * - App-specific events (snapshots, file changes, etc.) are sent as CUSTOM AG-UI events
 * - Frontend uses useChat + fetchServerSentEvents to consume the stream natively
 * - Integrates retry, doom loop detection, context pruning, and token tracking
 *
 * Extracted modules:
 * - event-helpers.ts    — AG-UI event parsing and construction
 * - pending-changes.ts  — Server-side pending changes accumulation
 * - snapshot-manager.ts — Snapshot lifecycle (create, populate, cleanup)
 * - system-prompt-builder.ts — System prompt assembly
 * - plan-saver.ts       — Plan mode output persistence
 * - mcp-client.ts       — MCP client connection management
 */

import { chat, maxIterations, StreamProcessor } from '@tanstack/ai';
import { mount, withMounts } from 'worker-fs-mount';

import { DEFAULT_AI_MODEL, getModelConfig, getModelLimits } from '@shared/constants';

import { AgentLogger, sanitizeToolInput, serializeMessagesForLog, summarizeToolResult, truncateContent } from './agent-logger';
import { estimateMessagesTokens, getContextUtilization, hasContextBudget, pruneToolOutputs } from './context-pruner';
import { detectDoomLoop, MUTATION_FAILURE_TAG } from './doom-loop';
import { customEvent, getEventField, getEventRecord, getNumberField } from './event-helpers';
import { McpClientManager } from './mcp-client';
import { accumulatePendingChange, pendingChangesMapToRecord } from './pending-changes';
import { savePlan } from './plan-saver';
import { createAdapter as createReplicateAdapter } from './replicate';
import { classifyRetryableError, calculateRetryDelay, sleep } from './retry';
import { addFileToSnapshot, deleteDirectoryRecursive, initSnapshot } from './snapshot-manager';
import { buildSystemPrompts } from './system-prompt-builder';
import { deriveFallbackTitle } from './title-generator';
import { TokenTracker } from './token-tracker';
import { readTodos } from './tool-executor';
import { createSendEvent, createServerTools, MUTATION_TOOL_NAMES } from './tools';
import { isRecordObject, parseApiError } from './utilities';
import { createAdapter as createWorkersAiAdapter } from './workers-ai';
import { coordinatorNamespace } from '../../lib/durable-object-namespaces';

import type { SnapshotContext } from './snapshot-manager';
import type {
	CustomEventQueue,
	FileChange,
	ModelMessage,
	PendingToolCallIds,
	ToolCallIdReference,
	ToolExecutorContext,
	ToolFailureRecord,
} from './types';
import type { ExpiringFilesystem } from '../../durable/expiring-filesystem';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, PendingFileChange, ToolErrorInfo, ToolMetadataInfo } from '@shared/types';
import type { StreamChunk, UIMessage } from '@tanstack/ai';

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
 * Maximum number of continuation nudges when the model produces text
 * without tool calls but the task completion evaluator determines it
 * hasn't finished yet. Each nudge injects a corrective message and
 * retries. After this limit, the loop stops regardless.
 */

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
	private mcpClientManager = new McpClientManager();

	/** Shared logger instance, created at stream start and accessible to callers for post-stream logging. */
	private agentLogger: AgentLogger | undefined;

	/**
	 * Get the debug logger for this agent run.
	 * Available after `runAgentStream()` is called. The agent-runner uses this
	 * to append session-level log entries (title generation, status broadcasts)
	 * that are captured in the same debug log file.
	 */
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
				history: UIMessage[];
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
	 * Run the AI agent chat loop, returning a teed async iterable of stream chunks.
	 *
	 * The stream is "teed" through a server-side StreamProcessor that mirrors the
	 * client's UIMessage building. This enables the server to persist the session
	 * incrementally during streaming and on all termination paths (including client
	 * disconnect), producing UIMessage[] identical to what the client would build.
	 *
	 * Callers can consume the returned iterable however they wish:
	 * - Convert to SSE via `toServerSentEventsResponse()`
	 * - Broadcast chunks over WebSocket
	 * - Both (the AgentRunner DO does this)
	 */
	runAgentStream(
		messages: ModelMessage[],
		uiMessages: UIMessage[],
		abortController: AbortController,
		outputLogs?: string,
	): AsyncIterable<StreamChunk> {
		// Server-side StreamProcessor mirrors the client's UIMessage building.
		// Initialized with the conversation history the client sent (UIMessage[]),
		// so the processor already contains all prior messages when the new
		// assistant message is appended during streaming.
		const processor = new StreamProcessor({ initialMessages: uiMessages });

		// Mount the filesystem *before* creating the stream so that the
		// AsyncLocalStorage context established by withMounts() propagates
		// through the entire async generator chain. withMounts() uses
		// AsyncLocalStorage.run(), which preserves the store across awaits
		// *only* for async work that originates inside the callback. By
		// passing an async callback whose body awaits the full stream
		// consumption, every fs call inside the generators (e.g.
		// initSnapshot's fs.mkdir) sees the active mount.
		//
		// We use a ReadableStream as the bridge: the withMounts async
		// callback writes chunks into it, and the caller iterates the
		// readable side outside the ALS scope (reading doesn't need mounts).
		const { readable, writable } = new TransformStream<StreamChunk>();
		const writer = writable.getWriter();

		// Start the mount-scoped producer. The promise is intentionally
		// detached — the consumer drives backpressure via the stream.
		// Create the logger before the mount scope so it's accessible to the
		// agent-runner via getLogger() for session-level logging (title generation,
		// status broadcasts, etc.). Entries added by the agent-runner during the
		// for-await loop are included in the flush at the end of createAgentStream.
		const logger = new AgentLogger(this.sessionId, this.projectId, this.model, this.mode);
		this.agentLogger = logger;

		void withMounts(async () => {
			mount(this.projectRoot, this.fsStub);
			const innerStream = this.createAgentStream(messages, abortController, outputLogs, logger);
			const teedStream = this.createTeedStream(innerStream, processor, logger);

			try {
				for await (const chunk of teedStream) {
					await writer.write(chunk);
				}
				await writer.close();
			} catch (error) {
				await writer.abort(error);
			}
		});

		// Return an async iterable over the readable side
		return readable;
	}

	/**
	 * Re-flush the shared logger inside a mount scope.
	 *
	 * The primary flush happens at the end of `createAgentStream` (inside
	 * `withMounts`). If the caller adds log entries *after* the stream ends
	 * (e.g. agent-runner session-level events), those entries won't be
	 * persisted because the mount scope has closed. This method opens a
	 * fresh mount scope so `fs.writeFile` inside `flush()` can succeed.
	 */
	async flushLogger(): Promise<void> {
		const logger = this.agentLogger;
		if (!logger || logger.isFlushed) return;

		await withMounts(async () => {
			mount(this.projectRoot, this.fsStub);
			await logger.flush(this.projectRoot);
		});
	}

	/**
	 * Get the filesystem stub for use in tool context.
	 */
	getFsStub(): DurableObjectStub<ExpiringFilesystem> {
		return this.fsStub;
	}

	// =============================================================================
	// Session Persistence (Teed Stream)
	// =============================================================================

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
	private async *createTeedStream(
		innerStream: AsyncIterable<StreamChunk>,
		processor: StreamProcessor,
		logger: AgentLogger,
	): AsyncIterable<StreamChunk> {
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
		// Accumulate file_changed events for pending changes persistence.
		const streamPendingChanges = new Map<string, PendingFileChange>();
		// Accumulate structured tool metadata and errors for session persistence.
		const streamToolMetadata = new Map<string, ToolMetadataInfo>();
		const streamToolErrors = new Map<string, ToolErrorInfo>();

		const persistSession = async () => {
			processor.finalizeStream();

			// Drop empty assistant messages left by stream errors — the
			// agent-runner persists the terminal status separately.
			const messages = processor.getMessages();
			const lastMessage = messages.at(-1);
			if (lastMessage?.role === 'assistant' && lastMessage.parts.length === 0) {
				processor.setMessages(messages.slice(0, -1));
			}

			sessionPersisted = true;
			await this.persistSession(
				processor,
				snapshotId,
				userMessageIndex,
				contextTokensUsed,
				streamPendingChanges,
				streamToolMetadata,
				streamToolErrors,
			);
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
						case 'snapshot_deleted': {
							snapshotId = undefined;

							break;
						}
						case 'file_changed': {
							const data = isRecordObject(chunk.data) ? chunk.data : {};
							const path = typeof data.path === 'string' ? data.path : undefined;
							const action = typeof data.action === 'string' ? data.action : undefined;
							if (path && (action === 'create' || action === 'edit' || action === 'delete' || action === 'move')) {
								accumulatePendingChange(streamPendingChanges, {
									path,
									action,
									beforeContent: typeof data.beforeContent === 'string' ? data.beforeContent : undefined,
									afterContent: typeof data.afterContent === 'string' ? data.afterContent : undefined,
									snapshotId,
									sessionId: this.sessionId ?? '',
								});
							}

							break;
						}
						case 'tool_result': {
							const data = isRecordObject(chunk.data) ? chunk.data : {};
							const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
							if (toolCallId) {
								const rawMetadata = data.metadata;
								const metadataRecord: Record<string, unknown> = isRecordObject(rawMetadata) ? rawMetadata : {};
								streamToolMetadata.set(toolCallId, {
									toolCallId,
									toolName: typeof data.tool_name === 'string' ? data.tool_name : '',
									title: typeof data.title === 'string' ? data.title : '',
									metadata: metadataRecord,
								});
							}

							break;
						}
						case 'tool_error': {
							const data = isRecordObject(chunk.data) ? chunk.data : {};
							const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
							if (toolCallId) {
								streamToolErrors.set(toolCallId, {
									toolCallId,
									toolName: typeof data.toolName === 'string' ? data.toolName : '',
									errorCode: typeof data.errorCode === 'string' ? data.errorCode : '',
									errorMessage: typeof data.errorMessage === 'string' ? data.errorMessage : '',
								});
							}

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
							const timeSinceLastSave = now - lastSaveTimestamp;
							if (timeSinceLastSave >= SESSION_SAVE_THROTTLE_MS) {
								lastSaveTimestamp = now;
								logger.debug('session', 'incremental_persist', {
									snapshotId,
									contextTokensUsed,
									pendingChangeCount: streamPendingChanges.size,
									toolMetadataCount: streamToolMetadata.size,
									toolErrorCount: streamToolErrors.size,
									messageCount: processor.getMessages().length,
								});
								await this.persistSession(
									processor,
									snapshotId,
									userMessageIndex,
									contextTokensUsed,
									streamPendingChanges,
									streamToolMetadata,
									streamToolErrors,
								);
							} else {
								logger.debug('session', 'incremental_persist_throttled', {
									timeSinceLastSaveMs: timeSinceLastSave,
									throttleMs: SESSION_SAVE_THROTTLE_MS,
								});
							}

							break;
						}
						// No default
					}
				}

				yield chunk;
			}

			// Normal completion — persist the final state
			logger.info('session', 'final_persist', {
				snapshotId,
				contextTokensUsed,
				pendingChangeCount: streamPendingChanges.size,
				messageCount: processor.getMessages().length,
			});
			await persistSession();
		} finally {
			// Safety net: if the stream was cancelled (client disconnect) or an
			// error occurred before the normal completion path, persist whatever
			// progress was made. The `finally` block runs even when the generator's
			// return() is invoked by ReadableStream cancel().
			if (!sessionPersisted) {
				logger.info('session', 'safety_persist', {
					reason: 'stream_cancelled_or_error',
					messageCount: processor.getMessages().length,
				});
				await persistSession().catch(() => {});
			}
		}
	}

	/**
	 * Persist the current session state via the provided callback.
	 *
	 * Passes the UIMessage[] from the StreamProcessor (which mirrors what the
	 * client would have built) to the AgentRunner DO for storage.
	 *
	 * Non-fatal: errors are logged but never propagate to the caller.
	 */
	private async persistSession(
		processor: StreamProcessor,
		snapshotId: string | undefined,
		userMessageIndex: number,
		contextTokensUsed: number,
		streamPendingChanges?: Map<string, PendingFileChange>,
		streamToolMetadata?: Map<string, ToolMetadataInfo>,
		streamToolErrors?: Map<string, ToolErrorInfo>,
	): Promise<void> {
		if (!this.sessionId || !this.onPersistSession) return;

		try {
			const history = processor.getMessages();
			if (history.length === 0) {
				this.agentLogger?.debug('session', 'persist_skipped', { reason: 'empty_history' });
				return;
			}

			const createdAt = Date.now();
			const messageSnapshots: Record<string, string> = {};

			if (snapshotId && userMessageIndex >= 0) {
				messageSnapshots[String(userMessageIndex)] = snapshotId;
			}

			// Record the agent mode for this user message so the UI can display
			// mode badges per-message even after session reload / DO eviction.
			const messageModes: Record<string, AgentMode> = {};
			if (userMessageIndex >= 0) {
				messageModes[String(userMessageIndex)] = this.mode;
			}

			// Derive title from the first user message
			const firstUserMessage = history.find((message) => message.role === 'user');
			const firstUserText = firstUserMessage
				? firstUserMessage.parts
						.filter((part): part is { type: 'text'; content: string } => part.type === 'text')
						.map((part) => part.content)
						.join(' ')
						.trim()
				: '';
			const title = deriveFallbackTitle(firstUserText);

			this.agentLogger?.debug('session', 'persist_session_data', {
				historyLength: history.length,
				fallbackTitle: title,
				firstUserTextLength: firstUserText.length,
				snapshotId,
				userMessageIndex,
				contextTokensUsed,
				mode: this.mode,
			});

			const sessionData = {
				createdAt,
				title,
				history,
				messageSnapshots: Object.keys(messageSnapshots).length > 0 ? messageSnapshots : undefined,
				messageModes: Object.keys(messageModes).length > 0 ? messageModes : undefined,
				contextTokensUsed: contextTokensUsed > 0 ? contextTokensUsed : undefined,
				toolMetadata: streamToolMetadata && streamToolMetadata.size > 0 ? Object.fromEntries(streamToolMetadata) : undefined,
				toolErrors: streamToolErrors && streamToolErrors.size > 0 ? Object.fromEntries(streamToolErrors) : undefined,
			};

			const pendingChangesRecord = streamPendingChanges ? pendingChangesMapToRecord(streamPendingChanges) : undefined;

			await this.onPersistSession(this.sessionId, sessionData, pendingChangesRecord);
		} catch (error) {
			// Non-fatal — don't let session persistence break the agent stream
			this.agentLogger?.error('session', 'persist_failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			console.error('Failed to persist AI session:', error);
		}
	}

	// =============================================================================
	// Agent Loop
	// =============================================================================

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
		abortController: AbortController,
		outputLogs?: string,
		logger?: AgentLogger,
	): AsyncIterable<StreamChunk> {
		const signal = abortController.signal;
		const queryChanges: FileChange[] = [];
		const tokenTracker = new TokenTracker();
		const eventQueue: CustomEventQueue = [];
		// Use the provided logger or create a local one as fallback
		logger ??= new AgentLogger(this.sessionId, this.projectId, this.model, this.mode);

		logger.info('agent_loop', 'started', {
			mode: this.mode,
			model: this.model,
			sessionId: this.sessionId,
			messageCount: messages.length,
			maxIterations: MAX_ITERATIONS,
			softLimit: SOFT_ITERATION_LIMIT,
		});

		// Mutable ref for the currently-executing tool call ID.
		// Set by each tool wrapper before execution; read by sendEvent to auto-inject
		// toolCallId into CUSTOM events (tool_result, file_changed).
		const toolCallIdReference: ToolCallIdReference = { current: undefined };

		// Ordered queue of tool call IDs from Phase 1 TOOL_CALL_END events.
		// Each tool wrapper shift()s the next ID before executing, matching the
		// sequential execution order guaranteed by TanStack AI.
		const pendingToolCallIds: PendingToolCallIds = [];

		// Create the sendEvent function that pushes CUSTOM events to the queue
		const sendEvent = createSendEvent(eventQueue, toolCallIdReference);

		// Eagerly create a snapshot directory for code mode
		let snapshotContext: SnapshotContext | undefined;
		if (this.mode === 'code') {
			snapshotContext = await initSnapshot(this.projectRoot, this.sessionId, messages, sendEvent);
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

		// Track whether the debug-log-ready broadcast succeeded. The finally
		// block uses this (independently of logger.isFlushed) to retry the
		// broadcast when the flush succeeded but the coordinator RPC failed.
		let debugLogBroadcasted = false;

		try {
			yield customEvent('status', { message: 'Starting...' });

			// Build system prompts
			const systemPrompts = await buildSystemPrompts(this.projectRoot, this.mode, outputLogs, this.sessionId);
			logger.debug('message', 'system_prompt_built', {
				promptCount: systemPrompts.length,
				totalLength: systemPrompts.reduce((sum, p) => sum + p.length, 0),
				prompts: systemPrompts.map((prompt, index) => ({
					index,
					content: truncateContent(prompt),
					length: prompt.length,
				})),
			});

			const modelConfig = getModelConfig(this.model);
			if (!modelConfig) {
				throw new Error(`Unknown model: ${this.model}`);
			}
			const provider = modelConfig.provider;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Both adapters implement chatStream but have different generic params; chat() accepts AnyTextAdapter
			const adapter: any = provider === 'workers-ai' ? createWorkersAiAdapter(this.model) : createReplicateAdapter(this.model, logger);
			const modelLimits = getModelLimits(this.model);
			const toolContext: ToolExecutorContext = {
				projectRoot: this.projectRoot,
				projectId: this.projectId,
				mode: this.mode,
				sessionId: this.sessionId,
				callMcpTool: (serverId, toolName, arguments_) => this.mcpClientManager.callTool(serverId, toolName, arguments_),
				sendCdpCommand: (id, method, parameters) => coordinatorStub.sendCdpCommand(id, method, parameters),
			};

			// Mutable copy of messages for the agent loop
			const workingMessages = [...messages];

			// Track where this run's messages begin, so doom loop detection only
			// considers tool calls from the current run (not prior user turns).
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

				// Create tools fresh each iteration (they capture the mutable queryChanges array).
				const toolFailures: ToolFailureRecord[] = [];
				pendingToolCallIds.length = 0; // Reset for this iteration
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

				// Call the LLM and consume its stream, with unified retry for both
				// connection-phase errors (chat() throws synchronously) and mid-stream
				// errors (for-await throws or adapter emits RUN_ERROR with a retryable message).
				let hadToolCalls = false;
				let hadUserQuestion = false;
				let hadMutationFailure = false;
				let hadStreamError = false;
				let retryAttempt = 0;
				let llmTimer = logger.startTimer();
				const completedToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
				const toolResults: Array<{ toolCallId: string; content: string }> = [];
				const toolCallArgumentsById = new Map<string, { name: string; arguments: string; input: Record<string, unknown> }>();

				logger.info('llm', 'request_start', {
					model: this.model,
					maxTokens: modelLimits.maxOutput,
					toolCount: tools.length,
					messages: serializeMessagesForLog(workingMessages),
				});

				// Track text from a previous attempt that was interrupted mid-stream.
				// When non-empty, the first TEXT_MESSAGE_START from the retry is
				// suppressed so the StreamProcessor keeps accumulating into the
				// same TextPart instead of replacing it.
				let partialTextBeforeRetry = '';

				while (true) {
					// Per-attempt stream state — reset on each retry
					let streamError: string | undefined;
					let streamErrorRaw: unknown;
					let currentToolCallId: string | undefined;
					let currentToolName: string | undefined;
					let currentToolArguments = '';
					let streamChunkCount = 0;
					let hadRunStarted = false;
					let hadRunFinished = false;
					let caughtStreamError: unknown;
					let suppressedTextMessageStart = false;

					try {
						llmTimer = logger.startTimer();
						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack AI message types are restrictive
						const messagesCopy: any = [...workingMessages];
						const chatResult = chat({
							adapter,
							messages: messagesCopy,
							systemPrompts,
							tools,
							maxTokens: modelLimits.maxOutput,
							agentLoopStrategy: maxIterations(1),
						});

						// Consume the AG-UI event stream from chat()
						for await (const chunk of chatResult) {
							if (signal.aborted) break;
							streamChunkCount++;

							if (!isRecordObject(chunk)) continue;
							const eventType = getEventField(chunk, 'type');

							switch (eventType) {
								case 'TEXT_MESSAGE_CONTENT': {
									const delta = getEventField(chunk, 'delta');
									if (delta) {
										lastAssistantText += delta;
									}
									yield chunk;
									break;
								}
								case 'TEXT_MESSAGE_START': {
									// On a retry after partial text, suppress the first
									// TEXT_MESSAGE_START so the downstream StreamProcessor
									// keeps accumulating into the existing TextPart instead
									// of resetting and replacing the partial text.
									if (partialTextBeforeRetry && !suppressedTextMessageStart) {
										suppressedTextMessageStart = true;
										logger.debug('llm', 'text_message_start_suppressed', {
											partialTextLength: partialTextBeforeRetry.length,
										});
										break;
									}
									lastAssistantText = '';
									logger.debug('llm', 'text_message_start', { chunksReceived: streamChunkCount });
									yield chunk;
									break;
								}
								case 'TEXT_MESSAGE_END': {
									logger.debug('llm', 'text_message_end', { textLength: lastAssistantText.length });
									// Log the full text content for debugging
									if (lastAssistantText.length > 0) {
										logger.debug('llm', 'text_content', {
											content: truncateContent(lastAssistantText),
											contentLength: lastAssistantText.length,
										});
									}
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
										const stored = toolCallArgumentsById.get(toolCallId);
										const resolvedName = toolName || stored?.name || 'unknown';
										const resolvedArguments = stored?.arguments ?? '';
										const resolvedInput = stored?.input ?? {};

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

										toolCallArgumentsById.delete(toolCallId);
									} else {
										// Phase 1: Adapter signals arguments are finalized (no result yet).
										let toolInput: Record<string, unknown> = {};

										// Some adapters may not emit TOOL_CALL_ARGS events, instead
										// providing the parsed input directly on the TOOL_CALL_END chunk.
										const chunkInput = getEventRecord(chunk, 'input');
										if (!currentToolArguments && chunkInput) {
											currentToolArguments = JSON.stringify(chunkInput);
										}

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

										if (toolCallId) {
											toolCallArgumentsById.set(toolCallId, {
												name: toolName ?? 'unknown',
												arguments: currentToolArguments,
												input: toolInput,
											});
											pendingToolCallIds.push(toolCallId);
										}

										logger.info('tool_call', 'args_complete', {
											toolCallId,
											toolName,
											input: sanitizeToolInput(toolInput),
										});

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

									// Drain any CUSTOM events from tool execution.
									while (eventQueue.length > 0) {
										const queued = eventQueue.shift();
										if (queued) yield queued;
									}

									break;
								}
								case 'RUN_FINISHED': {
									hadRunFinished = true;
									const usage = getEventRecord(chunk, 'usage');
									const finishReason = getEventField(chunk, 'finishReason');
									const inputTokens = usage ? getNumberField(usage, 'inputTokens') || getNumberField(usage, 'input_tokens') : 0;
									const outputTokens = usage ? getNumberField(usage, 'outputTokens') || getNumberField(usage, 'output_tokens') : 0;
									if (usage) {
										tokenTracker.recordTurn(this.model, {
											inputTokens,
											outputTokens,
											cacheReadInputTokens:
												getNumberField(usage, 'cacheReadInputTokens') || getNumberField(usage, 'cache_read_input_tokens'),
											cacheCreationInputTokens:
												getNumberField(usage, 'cacheCreationInputTokens') || getNumberField(usage, 'cache_creation_input_tokens'),
										});
										logger.recordTokenUsage(inputTokens, outputTokens);
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
											output: truncateContent(lastAssistantText),
										},
										{ durationMs: llmTimer() },
									);
									yield chunk;
									break;
								}
								case 'RUN_ERROR': {
									const errorData = getEventRecord(chunk, 'error');
									const errorMessage = errorData ? getEventField(errorData, 'message') : 'Unknown error';
									const errorCode = errorData ? getEventField(errorData, 'code') : undefined;
									logger.error('llm', 'stream_error', {
										message: errorMessage,
										code: errorCode,
										streamState: {
											chunksReceived: streamChunkCount,
											hadRunStarted,
											hadRunFinished,
											textAccumulated: lastAssistantText.length,
											toolCallsInProgress: currentToolCallId
												? {
														id: currentToolCallId,
														name: currentToolName,
														argumentsLength: currentToolArguments.length,
													}
												: undefined,
											completedToolCalls: completedToolCalls.length,
											pendingToolCallIds: toolCallArgumentsById.size,
										},
									});
									streamError = errorMessage ?? 'Unknown error';
									// Build an Error for classification so classifyRetryableError can inspect it
									streamErrorRaw = new Error(streamError);
									// Don't yield the RUN_ERROR yet — we may retry
									break;
								}
								default: {
									switch (eventType) {
										case 'RUN_STARTED': {
											hadRunStarted = true;
											logger.debug('llm', 'run_started', {
												runId: getEventField(chunk, 'runId'),
											});

											break;
										}
										case 'STEP_STARTED': {
											logger.debug('llm', 'step_started', {
												stepId: getEventField(chunk, 'stepId'),
												stepType: getEventField(chunk, 'stepType'),
											});

											break;
										}
										case 'STEP_FINISHED': {
											const delta = getEventField(chunk, 'delta');
											logger.debug('llm', 'step_finished', {
												stepId: getEventField(chunk, 'stepId'),
												deltaLength: delta?.length ?? 0,
												...(delta ? { delta: truncateContent(delta) } : {}),
											});

											break;
										}
										// No default
									}
									yield chunk;
									break;
								}
							}
						}
					} catch (error) {
						caughtStreamError = error;
					}

					// Log if the stream ended without a proper termination event
					if (hadRunStarted && !hadRunFinished && !streamError && !caughtStreamError) {
						logger.warn('llm', 'stream_ended_prematurely', {
							chunksReceived: streamChunkCount,
							textAccumulated: lastAssistantText.length,
							completedToolCalls: completedToolCalls.length,
							pendingToolCallIds: toolCallArgumentsById.size,
							inProgressToolCall: currentToolCallId ? { id: currentToolCallId, name: currentToolName } : undefined,
						});
					}

					// Drain any remaining CUSTOM events from the last tool execution
					while (eventQueue.length > 0) {
						const queued = eventQueue.shift();
						if (queued) yield queued;
					}

					// Determine if we should retry based on the error source
					const errorToClassify = caughtStreamError ?? streamErrorRaw;
					if (errorToClassify) {
						// Abort errors are never retryable
						if (errorToClassify instanceof Error && errorToClassify.name === 'AbortError') {
							throw errorToClassify;
						}

						retryAttempt++;
						const retryReason = classifyRetryableError(errorToClassify);

						if (retryReason && retryAttempt < MAX_RETRY_ATTEMPTS) {
							const delay = calculateRetryDelay(retryAttempt, errorToClassify);
							const hadPartialOutput = lastAssistantText.length > 0 || completedToolCalls.length > 0;
							logger.warn('llm', 'retry', {
								retryAttempt,
								reason: retryReason,
								delayMs: delay,
								phase: caughtStreamError ? 'stream' : 'adapter_error',
								partialTextLength: lastAssistantText.length,
								completedToolCallsBeforeError: completedToolCalls.length,
							});
							yield customEvent('status', { message: `Retrying (${retryReason})...` });
							await sleep(delay, signal);

							// Preserve partial output so the model can resume from where
							// it left off instead of regenerating from scratch.
							if (hadPartialOutput) {
								if (completedToolCalls.length > 0) {
									// Tool calls that fully executed (with results) are committed
									// to the message history — their side effects already happened.
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
									// After tool results, the UI's last part is a tool-result —
									// the retry's TEXT_MESSAGE_START should flow through normally
									// so updateTextPart pushes a new TextPart.
									partialTextBeforeRetry = '';
								} else if (lastAssistantText) {
									// Only text was generated — append it so the model
									// sees what it already wrote and continues.
									workingMessages.push({
										role: 'assistant',
										content: lastAssistantText,
									});
									// Signal the next attempt to suppress TEXT_MESSAGE_START
									// so the StreamProcessor continues accumulating into the
									// same TextPart instead of replacing it.
									partialTextBeforeRetry = lastAssistantText;
								}
								workingMessages.push({
									role: 'user',
									content:
										'SYSTEM: Your previous response was interrupted by a connection error. ' +
										'Continue from where you left off. Do NOT repeat what you already said or re-call tools that already succeeded.',
								});
							} else {
								// No partial output — fresh retry, no suppression needed
								partialTextBeforeRetry = '';
							}

							// Reset accumulation state for the next attempt
							lastAssistantText = '';
							completedToolCalls.length = 0;
							toolResults.length = 0;
							toolCallArgumentsById.clear();
							continue;
						}

						// Non-retryable or retries exhausted
						if (caughtStreamError) {
							logger.error('llm', 'request_failed', {
								retryAttempt,
								reason: retryReason ?? 'non_retryable',
								error: caughtStreamError instanceof Error ? caughtStreamError.message : String(caughtStreamError),
							});
							throw caughtStreamError;
						}

						// streamError from RUN_ERROR — yield the error event and stop the loop
						const errorMessage = streamError ?? 'Unknown error';
						logger.error('llm', 'request_failed', {
							retryAttempt,
							reason: retryReason ?? 'non_retryable',
							error: errorMessage,
						});
						yield {
							type: 'RUN_ERROR',
							timestamp: Date.now(),
							error: { message: errorMessage },
						};
						hadStreamError = true;
						continueLoop = false;
						break;
					}

					// Success — exit the retry loop
					break;
				}

				// Incrementally persist new file changes to the snapshot
				if (snapshotContext && queryChanges.length > changeCountBefore) {
					const newChanges = queryChanges.length - changeCountBefore;
					logger.debug('snapshot', 'persisting_file_changes', {
						newChangeCount: newChanges,
						totalChangeCount: queryChanges.length,
						snapshotId: snapshotContext.id,
					});
					for (let index = changeCountBefore; index < queryChanges.length; index++) {
						await addFileToSnapshot(snapshotContext, queryChanges[index]);
					}
				}

				// Reconstruct messages for the next iteration
				if (hadStreamError) {
					// fall through to iteration_end logging below
				} else if (hadToolCalls && completedToolCalls.length > 0) {
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

					// Plan mode enforcement: nudge the agent to create a todo list if
					// it has been working (iteration > 1) without one.
					if (this.mode === 'plan' && !planModeTodoNudged && iteration > 1) {
						const currentTodos = await readTodos(this.projectRoot, this.sessionId);
						if (currentTodos.length === 0) {
							planModeTodoNudged = true;
							logger.info('agent_loop', 'plan_mode_todo_nudge', { iteration });
							workingMessages.push({
								role: 'user',
								content:
									'SYSTEM: You are in PLAN MODE. You MUST create a structured todo list using `todos_update` ' +
									'to track your research tasks before continuing. Break down the planning work into ' +
									'specific steps and mark the current step as in_progress.',
							});
						}
					}

					completedToolCalls.length = 0;
					toolResults.length = 0;
				} else {
					// No tool calls — the model produced text only, stop the loop.
					logger.info('agent_loop', 'text_only_stop', {
						iteration,
						textLength: lastAssistantText.length,
						reason: 'no_tool_calls',
					});
					if (lastAssistantText) {
						workingMessages.push({ role: 'assistant', content: lastAssistantText });
					}
					continueLoop = false;
				}

				// Proactively check for new errors/warnings in the IDE output.
				const fileChangesThisIteration = queryChanges.length - changeCountBefore;
				if (continueLoop && fileChangesThisIteration > 0) {
					try {
						// Brief delay to let HMR rebuild and the frontend sync logs
						await sleep(2000, signal);
						const freshLogs = await coordinatorStub.getOutputLogs();
						if (freshLogs && freshLogs !== (outputLogs ?? '')) {
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
				const loopResult = continueLoop ? detectDoomLoop(workingMessages, currentRunStartIndex) : { isDoomLoop: false };
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
					logger.info('agent_loop', 'user_question_stop', { iteration });
					continueLoop = false;
				}

				logger.info('agent_loop', 'iteration_end', {
					iteration,
					hadToolCalls,
					hadUserQuestion,
					continueLoop,
					fileChangesThisIteration,
				});

				logger.debug('agent_loop', 'turn_complete_emitted', { iteration });
				yield customEvent('turn_complete', {});
			}

			// Detect iteration limit hit
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

			// Clean up empty snapshots and notify downstream to clear the snapshot ID
			if (snapshotContext && queryChanges.length === 0) {
				logger.debug('snapshot', 'cleanup_empty', { snapshotId: snapshotContext.id });
				await deleteDirectoryRecursive(snapshotContext.directory);
				yield customEvent('snapshot_deleted', { id: snapshotContext.id });
			} else if (snapshotContext) {
				logger.debug('snapshot', 'retained', {
					snapshotId: snapshotContext.id,
					fileChangeCount: queryChanges.length,
				});
			}

			// In plan mode, save the plan
			if (this.mode === 'plan' && lastAssistantText.trim()) {
				logger.info('agent_loop', 'plan_save', { textLength: lastAssistantText.length });
				yield* savePlan(this.projectRoot, lastAssistantText, workingMessages);
			}

			if (hitIterationLimit) {
				yield customEvent('max_iterations_reached', { iterations: iteration });
			}

			// Emit token usage summary
			const totalUsage = tokenTracker.getTotalUsage();
			if (totalUsage.input > 0 || totalUsage.output > 0) {
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
			debugLogBroadcasted = await this.broadcastDebugLogReady(coordinatorStub, logger.id);
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				logger.info('agent_loop', 'aborted');
				logger.markAborted();
				await logger.flush(this.projectRoot);
				if (snapshotContext && queryChanges.length === 0) {
					try {
						await deleteDirectoryRecursive(snapshotContext.directory);
					} catch {
						// No-op
					}
				}
				debugLogBroadcasted = await this.broadcastDebugLogReady(coordinatorStub, logger.id);
				return;
			}
			console.error('Agent loop error:', error);
			logger.error('agent_loop', 'error', {
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			await logger.flush(this.projectRoot);
			if (snapshotContext && queryChanges.length === 0) {
				try {
					await deleteDirectoryRecursive(snapshotContext.directory);
				} catch {
					// No-op
				}
			}
			debugLogBroadcasted = await this.broadcastDebugLogReady(coordinatorStub, logger.id);
			const parsed = parseApiError(error);
			yield {
				type: 'RUN_ERROR',
				timestamp: Date.now(),
				error: { message: parsed.message, code: parsed.code },
			};
		} finally {
			if (!logger.isFlushed) {
				logger.info('agent_loop', 'aborted');
				logger.markAborted();
				await logger.flush(this.projectRoot).catch(() => {});
				if (snapshotContext && queryChanges.length === 0) {
					try {
						await deleteDirectoryRecursive(snapshotContext.directory);
					} catch {
						// No-op
					}
				}
			}
			if (!debugLogBroadcasted) {
				await this.broadcastDebugLogReady(coordinatorStub, logger.id);
			}
			await this.mcpClientManager.closeAll();
		}
	}

	// =============================================================================
	// Debug Log Broadcasting
	// =============================================================================

	/**
	 * Broadcast a debug-log-ready message to all connected clients via the
	 * project coordinator WebSocket.
	 *
	 * Returns `true` if the broadcast succeeded, `false` if it failed.
	 * Failures are non-fatal.
	 */
	private async broadcastDebugLogReady(
		coordinatorStub: DurableObjectStub<import('../../durable/project-coordinator').ProjectCoordinator>,
		logId: string,
	): Promise<boolean> {
		try {
			await coordinatorStub.sendMessage({
				type: 'debug-log-ready',
				id: logId,
				sessionId: this.sessionId ?? '',
			});
			return true;
		} catch (error) {
			console.error('Failed to broadcast debug-log-ready:', error);
			return false;
		}
	}
}
