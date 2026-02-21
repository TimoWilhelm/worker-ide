/**
 * AI Agent Service.
 * Handles the Claude AI agent loop with streaming response using TanStack AI.
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
import { chat, maxIterations, toServerSentEventsResponse } from '@tanstack/ai';
import { mount, withMounts } from 'worker-fs-mount';

import {
	AGENT_SYSTEM_PROMPT,
	AGENTS_MD_MAX_CHARACTERS,
	ASK_MODE_SYSTEM_PROMPT,
	DEFAULT_AI_MODEL,
	MCP_SERVERS,
	PLAN_MODE_SYSTEM_PROMPT,
} from '@shared/constants';

import { AgentLogger } from './agent-logger';
import { isContextOverflow, pruneToolOutputs } from './context-pruner';
import { DoomLoopDetector } from './doom-loop';
import { createAdapter, getModelLimits } from './replicate';
import { classifyRetryableError, calculateRetryDelay, sleep } from './retry';
import { TokenTracker } from './token-tracker';
import { createSendEvent, createServerTools } from './tools';
import { isRecordObject, parseApiError } from './utilities';
import { coordinatorNamespace } from '../../lib/durable-object-namespaces';

import type { CustomEventQueue, FileChange, ModelMessage, SnapshotMetadata, ToolExecutorContext } from './types';
import type { ExpiringFilesystem } from '../../durable/expiring-filesystem';
import type { AIModelId } from '@shared/constants';
import type { StreamChunk } from '@tanstack/ai';

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

/** Maximum number of agent loop iterations (LLM calls) */
const MAX_ITERATIONS = 10;

/** Maximum retry attempts for a single LLM call */
const MAX_RETRY_ATTEMPTS = 5;

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
	 */
	async runAgentChat(messages: ModelMessage[], apiKey: string, signal?: AbortSignal, outputLogs?: string): Promise<Response> {
		const abortController = new AbortController();

		// Forward external signal to our controller
		if (signal) {
			signal.addEventListener('abort', () => abortController.abort(), { once: true });
		}

		// Run the agent loop in a mount scope (for worker-fs-mount)
		const stream = withMounts(() => {
			mount(this.projectRoot, this.fsStub);
			return this.createAgentStream(messages, apiKey, abortController, outputLogs);
		});

		return toServerSentEventsResponse(stream, { abortController });
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
		const doomDetector = new DoomLoopDetector();
		const tokenTracker = new TokenTracker();
		const eventQueue: CustomEventQueue = [];
		const logger = new AgentLogger(this.sessionId, this.projectId, this.model, this.mode);

		logger.info('agent_loop', 'started', {
			mode: this.mode,
			model: this.model,
			sessionId: this.sessionId,
			messageCount: messages.length,
			maxIterations: MAX_ITERATIONS,
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

			// Create tool executor context
			const coordinatorId = coordinatorNamespace.idFromName(`project:${this.projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
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

			while (continueLoop && iteration < MAX_ITERATIONS) {
				if (signal.aborted) {
					logger.info('agent_loop', 'aborted', { iteration });
					logger.markAborted();
					yield customEvent('status', { message: 'Interrupted' });
					break;
				}

				iteration++;
				logger.setIteration(iteration);
				logger.info('agent_loop', 'iteration_start', {
					iteration,
					workingMessageCount: workingMessages.length,
				});
				yield customEvent('status', {
					message: this.mode === 'plan' ? 'Researching...' : 'Thinking...',
				});

				// Check context overflow and prune if needed
				if (isContextOverflow(workingMessages, modelLimits)) {
					logger.info('context', 'overflow_check', { overflow: true });
					const { messages: prunedMessages, prunedTokens } = pruneToolOutputs(workingMessages);
					if (prunedTokens > 0) {
						logger.info('context', 'prune_executed', {
							prunedTokens,
							messageCountBefore: workingMessages.length,
							messageCountAfter: prunedMessages.length,
						});
						workingMessages.length = 0;
						workingMessages.push(...prunedMessages);
						yield customEvent('status', {
							message: `Pruned ${prunedTokens} tokens of old tool output`,
						});
					}
				}

				// Track file changes before this iteration for snapshot
				const changeCountBefore = queryChanges.length;

				// Create tools fresh each iteration (they capture the mutable queryChanges array)
				const tools = createServerTools(sendEvent, toolContext, queryChanges, this.mode, logger);

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
				let currentToolCallId: string | undefined;
				let currentToolName: string | undefined;
				let currentToolArguments = '';
				const completedToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
				const toolResults: Array<{ toolCallId: string; content: string }> = [];

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

							// Record for doom loop detection
							if (toolName) {
								let toolInput: Record<string, unknown> = {};
								try {
									toolInput = JSON.parse(currentToolArguments || '{}');
								} catch {
									logger.warn('tool_call', 'arguments_parse_error', {
										toolCallId,
										toolName,
										rawArguments: currentToolArguments.slice(0, 200),
									});
								}
								doomDetector.record(toolName, toolInput);
								logger.recordToolCall(toolName);
							}

							// Track completed tool call for message reconstruction
							if (toolCallId && toolName) {
								completedToolCalls.push({ id: toolCallId, name: toolName, arguments: currentToolArguments });
								const resultContent = getEventField(chunk, 'result');
								toolResults.push({ toolCallId, content: resultContent ?? '' });
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

							currentToolCallId = undefined;
							currentToolName = undefined;
							currentToolArguments = '';
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
					completedToolCalls.length = 0;
					toolResults.length = 0;
				} else {
					if (lastAssistantText) {
						workingMessages.push({ role: 'assistant', content: lastAssistantText });
					}
					logger.info('agent_loop', 'no_tool_calls_stop', {
						textLength: lastAssistantText.length,
						// Include a snippet of the raw output to help diagnose why no tool
						// calls were parsed — e.g., the model emitted tool calls in an
						// unrecognized format that was treated as plain text.
						outputSnippet: lastAssistantText.slice(0, 500),
						// Flag suspicious patterns that may indicate an unrecognized tool call format
						containsXmlTags:
							lastAssistantText.includes('<function_calls>') ||
							lastAssistantText.includes('<invoke') ||
							lastAssistantText.includes('<tool_use>') ||
							lastAssistantText.includes('<tool_call>'),
					});
					continueLoop = false;
				}

				// Check doom loop
				const doomLoopTool = doomDetector.isDoomLoop();
				if (doomLoopTool) {
					logger.warn('agent_loop', 'doom_loop_detected', {
						toolName: doomLoopTool,
						totalToolCalls: doomDetector.length,
					});
					logger.markDoomLoop();
					yield customEvent('status', {
						message: `Detected repeated calls to ${doomLoopTool}, stopping.`,
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
					fileChangesThisIteration: queryChanges.length - changeCountBefore,
				});

				yield customEvent('turn_complete', {});
			}

			// Detect iteration limit hit
			if (continueLoop && iteration >= MAX_ITERATIONS && !signal.aborted) {
				hitIterationLimit = true;
				logger.warn('agent_loop', 'iteration_limit', {
					maxIterations: MAX_ITERATIONS,
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
				yield customEvent('max_iterations_reached', { iterations: MAX_ITERATIONS });
			}

			// Emit token usage summary
			const totalUsage = tokenTracker.getTotalUsage();
			if (totalUsage.input > 0 || totalUsage.output > 0) {
				yield customEvent('usage', {
					input: totalUsage.input,
					output: totalUsage.output,
					cacheRead: totalUsage.cacheRead,
					cacheWrite: totalUsage.cacheWrite,
					turns: tokenTracker.turnCount,
				});
			}

			// Log completion and flush
			logger.info('agent_loop', 'completed', {
				totalIterations: iteration,
				totalFileChanges: queryChanges.length,
				hitIterationLimit,
			});
			await logger.flush(this.projectRoot);
			yield customEvent('debug_log', { id: logger.id });
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
				yield customEvent('debug_log', { id: logger.id });
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
					await this.deleteDirectoryRecursive(snapshotContext.directory);
				} catch {
					// No-op
				}
			}
			const parsed = parseApiError(error);
			yield {
				type: 'RUN_ERROR',
				timestamp: Date.now(),
				error: { message: parsed.message, code: parsed.code ?? undefined },
			};
			yield customEvent('debug_log', { id: logger.id });
		} finally {
			await this.closeMcpClients();
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
