/**
 * Integration tests for AIAgentService.createAgentStream orchestration.
 *
 * Tests the agent loop lifecycle by mocking external dependencies
 * (streamText, generateText, filesystem, coordinator) while exercising
 * the real orchestration logic: iteration control, event emission,
 * tool call flow, abort handling, retry, doom loop detection, steering,
 * context budget, and session persistence.
 */

import { streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AIAgentService } from './service';

import type { StreamEvent } from '@shared/agent-state';
import type { AgentMode, ChatMessage, PendingFileChange } from '@shared/types';

// =============================================================================
// Module Mocks
// =============================================================================

// Mock worker-fs-mount (the service wraps the stream in withMounts)
vi.mock('worker-fs-mount', () => ({
	mount: vi.fn(),
	withMounts: vi.fn(async (callback: () => Promise<void>) => callback()),
}));

// Mock the workers-ai adapter
vi.mock('./workers-ai', () => ({
	createAdapter: vi.fn(() => ({
		specificationVersion: 'v2',
		provider: 'workers-ai',
		modelId: 'test-model',
	})),
}));

// Mock the coordinator namespace
const mockGetOutputLogs = vi.fn<() => Promise<string | undefined>>(async (): Promise<string | undefined> => undefined);
const mockSendCdpCommand = vi.fn().mockResolvedValue({ result: '{}' });
vi.mock('../../lib/durable-object-namespaces', () => ({
	coordinatorNamespace: {
		getByName: vi.fn(() => ({
			getOutputLogs: mockGetOutputLogs,
			sendCdpCommand: mockSendCdpCommand,
		})),
	},
}));

// Mock snapshot-manager
vi.mock('./snapshot-manager', () => ({
	initSnapshot: vi.fn(async () => ({
		id: 'snap-test-001',
		directory: '/project/.agent/snapshots/snap-test-001',
	})),
	addFileToSnapshot: vi.fn(async () => {}),
	deleteDirectoryRecursive: vi.fn(async () => {}),
}));

// Mock system-prompt-builder
vi.mock('./system-prompt-builder', () => ({
	buildSystemPrompts: vi.fn(async () => ['You are a helpful assistant.']),
}));

// Mock plan-saver (yields no events by default)
vi.mock('./plan-saver', () => ({
	savePlan: vi.fn(function* () {
		/* no-op */
	}),
}));

// Mock MCP dependencies — the McpClientManager creates MCP clients internally.
// Mock the SDK transport to prevent actual network calls. The manager's closeAll()
// iterates its internal client map which will be empty since no tools call MCP.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
	Client: vi.fn().mockImplementation(() => ({
		connect: vi.fn(async () => {}),
		callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'mock' }] })),
		close: vi.fn(async () => {}),
	})),
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
	StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}));

// Mock node:fs/promises and node:diagnostics_channel so AgentLogger
// doesn't try real filesystem I/O or diagnostics channel publishing.
vi.mock('node:fs/promises', () => ({
	default: {
		mkdir: vi.fn(async () => {}),
		writeFile: vi.fn(async () => {}),
		readdir: vi.fn().mockResolvedValue([]),
		unlink: vi.fn(async () => {}),
		readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
		stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
		access: vi.fn().mockRejectedValue(new Error('ENOENT')),
		rm: vi.fn(async () => {}),
	},
}));

// We need to mock streamText and generateText from 'ai'
const mockStreamTextResult = {
	fullStream: {
		async *[Symbol.asyncIterator]() {
			yield { type: 'text-delta', text: 'Hello' };
			yield { type: 'text-delta', text: ' world' };
			yield { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20 } };
			yield { type: 'finish', finishReason: 'stop' };
		},
	},
	response: Promise.resolve({
		messages: [
			{
				role: 'assistant',
				content: [{ type: 'text', text: 'Hello world' }],
			},
		],
	}),
};

vi.mock('ai', async (importOriginal) => {
	const original = await importOriginal<typeof import('ai')>();
	return {
		...original,
		streamText: vi.fn(() => ({ ...mockStreamTextResult })),
		generateText: vi.fn(async () => ({
			text: 'Summary',
			toolCalls: [],
			response: { messages: [] },
		})),
	};
});

// =============================================================================
// Test Helpers
// =============================================================================

function makeUserMessage(content: string): ChatMessage {
	return {
		id: `msg-${crypto.randomUUID().slice(0, 8)}`,
		role: 'user',
		parts: [{ type: 'text', content }],
		createdAt: Date.now(),
	};
}

function makeModelMessages(content: string) {
	return [{ role: 'user' as const, content }];
}

function createTestService(
	overrides?: Partial<{
		mode: AgentMode;
		sessionId: string;
		onPersistSession: (
			sessionId: string,
			sessionData: Record<string, unknown>,
			pendingChanges?: Record<string, PendingFileChange>,
		) => Promise<void>;
		getSteeringMessages: () => Array<{ id: string; content: string }>;
	}>,
) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub for DurableObjectStub
	const fsStub = {} as any;

	return new AIAgentService(
		'/project',
		'test-project',
		fsStub,
		overrides?.sessionId ?? 'test-session',
		overrides?.mode ?? 'code',
		'@cf/moonshotai/kimi-k2.5',
		overrides?.onPersistSession,
		overrides?.getSteeringMessages,
	);
}

async function collectEvents(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

// =============================================================================
// Tests
// =============================================================================

describe('AIAgentService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ─── Basic text-only loop ──────────────────────────────────────────────

	describe('text-only response (no tool calls)', () => {
		it('emits status, text-delta, context-utilization, turn-complete, and usage events', async () => {
			const service = createTestService();
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			const events = await collectEvents(stream);

			const eventTypes = events.map((event) => event.type);

			// Should start with a status
			expect(eventTypes).toContain('status');

			// Should have text deltas
			const textDeltas = events.filter((event) => event.type === 'text-delta');
			expect(textDeltas.length).toBeGreaterThanOrEqual(1);

			// Should have context utilization
			expect(eventTypes).toContain('context-utilization');

			// Should have turn-complete
			expect(eventTypes).toContain('turn-complete');

			// Snapshot events: initSnapshot is mocked but doesn't push to the
			// event queue (it calls sendEvent internally in the real impl). The
			// empty-snapshot cleanup should still fire via deleteDirectoryRecursive.
			const { deleteDirectoryRecursive } = await import('./snapshot-manager');
			expect(deleteDirectoryRecursive).toHaveBeenCalled();
		});

		it('stops the loop after a text-only response (no tool calls)', async () => {
			const service = createTestService();
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			const events = await collectEvents(stream);

			// Exactly one turn-complete means the loop ran once and stopped
			const turnCompletes = events.filter((event) => event.type === 'turn-complete');
			expect(turnCompletes).toHaveLength(1);
		});

		it('calls onPersistSession after completion', async () => {
			const onPersistSession = vi.fn(async () => {});
			const service = createTestService({ onPersistSession, sessionId: 'persist-test' });
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			await collectEvents(stream);

			expect(onPersistSession).toHaveBeenCalledWith(
				'persist-test',
				expect.objectContaining({
					history: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
				}),
				// pendingChanges
				undefined,
			);
		});
	});

	// ─── Tool call loop ────────────────────────────────────────────────────

	describe('tool call iteration', () => {
		it('continues the loop when tool calls are present, stops on text-only', async () => {
			let callCount = 0;

			vi.mocked(streamText).mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					// First iteration: tool call
					return {
						fullStream: {
							async *[Symbol.asyncIterator]() {
								yield { type: 'tool-call', toolCallId: 'tc-1', toolName: 'file_read', input: { path: '/project/index.ts' } };
								yield { type: 'tool-result', toolCallId: 'tc-1', toolName: 'file_read', output: 'file content' };
								yield { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 20 } };
								yield { type: 'finish', finishReason: 'tool-calls' };
							},
						},
						response: Promise.resolve({
							messages: [
								{
									role: 'assistant',
									content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'file_read', input: { path: '/project/index.ts' } }],
								},
								{
									role: 'tool',
									content: [
										{ type: 'tool-result', toolCallId: 'tc-1', toolName: 'file_read', output: { type: 'text', value: 'file content' } },
									],
								},
							],
						}),
						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
					} as any;
				}
				// Second iteration: text only → stops the loop
				return {
					fullStream: {
						async *[Symbol.asyncIterator]() {
							yield { type: 'text-delta', text: 'Done!' };
							yield { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 200, outputTokens: 10 } };
							yield { type: 'finish', finishReason: 'stop' };
						},
					},
					response: Promise.resolve({
						messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done!' }] }],
					}),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
				} as any;
			});

			const service = createTestService();
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Read my file'), [makeUserMessage('Read my file')], abortController);
			const events = await collectEvents(stream);

			// Two turns: one with tool call, one with text only
			const turnCompletes = events.filter((event) => event.type === 'turn-complete');
			expect(turnCompletes).toHaveLength(2);

			// Should have tool-call events
			const toolStarts = events.filter((event) => event.type === 'tool-call-start');
			expect(toolStarts).toHaveLength(1);

			const toolEnds = events.filter((event) => event.type === 'tool-call-end');
			expect(toolEnds).toHaveLength(1);
		});
	});

	// ─── Abort handling ────────────────────────────────────────────────────

	describe('abort handling', () => {
		it('stops the loop when aborted before first iteration', async () => {
			const service = createTestService();
			const abortController = new AbortController();
			abortController.abort();

			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			const events = await collectEvents(stream);

			// Should emit a status event but no turn-complete
			const turnCompletes = events.filter((event) => event.type === 'turn-complete');
			expect(turnCompletes).toHaveLength(0);
		});

		it('stops the loop when aborted during iteration', async () => {
			const abortController = new AbortController();

			vi.mocked(streamText).mockImplementation(() => {
				// Abort mid-stream
				abortController.abort();
				return {
					fullStream: {
						async *[Symbol.asyncIterator]() {
							yield { type: 'text-delta', text: 'Starting...' };
							throw new DOMException('Aborted', 'AbortError');
						},
					},
					response: Promise.resolve({ messages: [] }),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
				} as any;
			});

			const service = createTestService();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			const events = await collectEvents(stream);

			// Should not have run-error (abort is not an error)
			const errors = events.filter((event) => event.type === 'run-error');
			expect(errors).toHaveLength(0);
		});

		it('resets per-attempt tool flags between retries', async () => {
			let callCount = 0;

			vi.mocked(streamText).mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					// First attempt emits a user_question tool call, then fails with a retryable error.
					return {
						fullStream: {
							async *[Symbol.asyncIterator]() {
								yield { type: 'tool-call', toolCallId: 'tc-q', toolName: 'user_question', input: { question: 'Which one?' } };
								yield { type: 'error', error: new Error('overloaded') };
							},
						},
						response: Promise.resolve({ messages: [] }),
						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
					} as any;
				}

				// Retry attempt succeeds with text-only output.
				return {
					fullStream: {
						async *[Symbol.asyncIterator]() {
							yield { type: 'text-delta', text: 'Recovered answer' };
							yield { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 10 } };
							yield { type: 'finish', finishReason: 'stop' };
						},
					},
					response: Promise.resolve({
						messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Recovered answer' }] }],
					}),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
				} as any;
			});

			const service = createTestService();
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			const events = await collectEvents(stream);

			// Should have a retry status
			const retryStatuses = events.filter((event) => event.type === 'status' && event.message.includes('Retrying'));
			expect(retryStatuses.length).toBeGreaterThanOrEqual(1);

			// Should have text deltas from the successful retry
			const textDeltas = events.filter((event) => event.type === 'text-delta');
			expect(textDeltas.length).toBeGreaterThanOrEqual(1);

			// Should have completed without run-error
			const errors = events.filter((event) => event.type === 'run-error');
			expect(errors).toHaveLength(0);
		});
	});

	// ─── Error and retry ───────────────────────────────────────────────────

	describe('error handling and retry', () => {
		it('emits run-error on non-retryable error', async () => {
			vi.mocked(streamText).mockImplementation(() => {
				return {
					fullStream: {
						async *[Symbol.asyncIterator]() {
							yield { type: 'error', error: new Error('Invalid API key') };
						},
					},
					response: Promise.resolve({ messages: [] }),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
				} as any;
			});

			const service = createTestService();
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			const events = await collectEvents(stream);

			const errors = events.filter((event) => event.type === 'run-error');
			expect(errors).toHaveLength(1);
		});

		it('retries on retryable errors then succeeds', async () => {
			let callCount = 0;

			vi.mocked(streamText).mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					// First call: retryable error (overloaded)
					return {
						fullStream: {
							async *[Symbol.asyncIterator]() {
								yield { type: 'error', error: new Error('overloaded') };
							},
						},
						response: Promise.resolve({ messages: [] }),
						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
					} as any;
				}
				// Second call: success
				return {
					fullStream: {
						async *[Symbol.asyncIterator]() {
							yield { type: 'text-delta', text: 'Recovered!' };
							yield { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 10 } };
							yield { type: 'finish', finishReason: 'stop' };
						},
					},
					response: Promise.resolve({
						messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Recovered!' }] }],
					}),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
				} as any;
			});

			const service = createTestService();
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			const events = await collectEvents(stream);

			// Should have a retry status
			const retryStatuses = events.filter((event) => event.type === 'status' && event.message.includes('Retrying'));
			expect(retryStatuses.length).toBeGreaterThanOrEqual(1);

			// Should have text deltas from the successful retry
			const textDeltas = events.filter((event) => event.type === 'text-delta');
			expect(textDeltas.length).toBeGreaterThanOrEqual(1);

			// Should have completed without run-error
			const errors = events.filter((event) => event.type === 'run-error');
			expect(errors).toHaveLength(0);
		});
	});

	// ─── Steering messages ─────────────────────────────────────────────────

	describe('steering message injection', () => {
		it('injects steering messages between tool-call iterations and re-enables the loop', async () => {
			let callCount = 0;
			let steeringDrained = false;

			const getSteeringMessages = vi.fn(() => {
				if (!steeringDrained) {
					steeringDrained = true;
					return [{ id: 'steer-1', content: 'Please also check the CSS' }];
				}
				return [];
			});

			vi.mocked(streamText).mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					// First iteration: tool call → loop continues → steering drained
					return {
						fullStream: {
							async *[Symbol.asyncIterator]() {
								yield { type: 'tool-call', toolCallId: 'tc-1', toolName: 'file_read', input: { path: '/project/index.ts' } };
								yield { type: 'tool-result', toolCallId: 'tc-1', toolName: 'file_read', output: 'content' };
								yield { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 10 } };
								yield { type: 'finish', finishReason: 'tool-calls' };
							},
						},
						response: Promise.resolve({
							messages: [
								{
									role: 'assistant',
									content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'file_read', input: { path: '/project/index.ts' } }],
								},
								{
									role: 'tool',
									content: [
										{
											type: 'tool-result',
											toolCallId: 'tc-1',
											toolName: 'file_read',
											output: { type: 'text', value: 'content' },
										},
									],
								},
							],
						}),
						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
					} as any;
				}
				// Second iteration (after steering): text only → stops
				return {
					fullStream: {
						async *[Symbol.asyncIterator]() {
							yield { type: 'text-delta', text: 'Done with CSS check' };
							yield { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 200, outputTokens: 10 } };
							yield { type: 'finish', finishReason: 'stop' };
						},
					},
					response: Promise.resolve({
						messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done with CSS check' }] }],
					}),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
				} as any;
			});

			const service = createTestService({ getSteeringMessages });
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			const events = await collectEvents(stream);

			// Should have 2 turns: tool call → steering drained → text only → stops
			const turnCompletes = events.filter((event) => event.type === 'turn-complete');
			expect(turnCompletes).toHaveLength(2);

			// The steering callback should have been called
			expect(getSteeringMessages).toHaveBeenCalled();

			// Should have a "Processing your message..." status from the steering drain
			const processingStatuses = events.filter((event) => event.type === 'status' && event.message.includes('Processing your message'));
			expect(processingStatuses.length).toBeGreaterThanOrEqual(1);
		});
	});

	// ─── Session persistence ───────────────────────────────────────────────

	describe('session persistence', () => {
		it('calls onPersistSession after each turn', async () => {
			let callCount = 0;

			vi.mocked(streamText).mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return {
						fullStream: {
							async *[Symbol.asyncIterator]() {
								yield { type: 'tool-call', toolCallId: 'tc-1', toolName: 'files_list', input: {} };
								yield { type: 'tool-result', toolCallId: 'tc-1', toolName: 'files_list', output: 'files' };
								yield { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 10 } };
								yield { type: 'finish', finishReason: 'tool-calls' };
							},
						},
						response: Promise.resolve({
							messages: [
								{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'files_list', input: {} }] },
								{
									role: 'tool',
									content: [
										{
											type: 'tool-result',
											toolCallId: 'tc-1',
											toolName: 'files_list',
											output: { type: 'text', value: 'files' },
										},
									],
								},
							],
						}),
						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
					} as any;
				}
				return {
					fullStream: {
						async *[Symbol.asyncIterator]() {
							yield { type: 'text-delta', text: 'Done' };
							yield { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 200, outputTokens: 10 } };
							yield { type: 'finish', finishReason: 'stop' };
						},
					},
					response: Promise.resolve({
						messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }],
					}),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
				} as any;
			});

			const onPersistSession = vi.fn(async () => {});
			const service = createTestService({ onPersistSession, sessionId: 'persist-each-turn' });
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Read files'), [makeUserMessage('Read files')], abortController);
			await collectEvents(stream);

			// Two turn persists + one final repersist after empty snapshot cleanup.
			expect(onPersistSession).toHaveBeenCalledTimes(3);
		});

		it('persists cleared messageSnapshots after deleting an empty snapshot', async () => {
			const onPersistSession = vi.fn<
				(
					sessionId: string,
					sessionData: { messageSnapshots?: Record<string, string> },
					pendingChanges?: Record<string, PendingFileChange>,
				) => Promise<void>
			>(async () => {});
			const service = createTestService({ onPersistSession, sessionId: 'snapshot-cleanup' });
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			await collectEvents(stream);

			expect(onPersistSession).toHaveBeenCalled();
			const lastCall = onPersistSession.mock.calls.at(-1);
			expect(lastCall).toBeDefined();
			if (!lastCall) return;

			const sessionData = lastCall[1];
			expect(sessionData).toEqual(
				expect.objectContaining({
					messageSnapshots: undefined,
				}),
			);
		});
	});

	// ─── Plan mode ─────────────────────────────────────────────────────────

	describe('plan mode', () => {
		it('does not create a snapshot in plan mode', async () => {
			const { initSnapshot } = await import('./snapshot-manager');

			const service = createTestService({ mode: 'plan' });
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Plan a feature'), [makeUserMessage('Plan a feature')], abortController);
			const events = await collectEvents(stream);

			// No snapshot-created event in plan mode
			const snapshotEvents = events.filter((event) => event.type === 'snapshot-created');
			expect(snapshotEvents).toHaveLength(0);
			expect(initSnapshot).not.toHaveBeenCalled();
		});
	});

	// ─── Context utilization ───────────────────────────────────────────────

	describe('context utilization', () => {
		it('emits context-utilization events during the loop', async () => {
			const service = createTestService();
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			const events = await collectEvents(stream);

			const contextEvents = events.filter((event) => event.type === 'context-utilization');
			// At least one from pre-iteration estimation + one from finish usage
			expect(contextEvents.length).toBeGreaterThanOrEqual(1);

			// Each should have the required fields
			for (const event of contextEvents) {
				if (event.type === 'context-utilization') {
					expect(event.estimatedTokens).toBeGreaterThanOrEqual(0);
					expect(event.contextWindow).toBeGreaterThan(0);
					expect(event.utilization).toBeGreaterThanOrEqual(0);
				}
			}
		});
	});

	// ─── Usage event ───────────────────────────────────────────────────────

	describe('usage tracking', () => {
		it('emits a usage event with token counts at the end', async () => {
			const service = createTestService();
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			const events = await collectEvents(stream);

			const usageEvents = events.filter((event) => event.type === 'usage');
			expect(usageEvents).toHaveLength(1);

			const usage = usageEvents[0];
			if (usage.type === 'usage') {
				expect(usage.input).toBeGreaterThan(0);
				expect(usage.output).toBeGreaterThan(0);
				expect(usage.turns).toBe(1);
			}
		});
	});

	// ─── User question stops the loop ──────────────────────────────────────

	describe('user_question tool stops the loop', () => {
		it('stops iterating after user_question tool is called', async () => {
			vi.mocked(streamText).mockImplementation(() => {
				return {
					fullStream: {
						async *[Symbol.asyncIterator]() {
							yield {
								type: 'tool-call',
								toolCallId: 'tc-q',
								toolName: 'user_question',
								input: { question: 'Which framework?' },
							};
							yield {
								type: 'tool-result',
								toolCallId: 'tc-q',
								toolName: 'user_question',
								output: 'Question asked',
							};
							yield { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 10 } };
							yield { type: 'finish', finishReason: 'tool-calls' };
						},
					},
					response: Promise.resolve({
						messages: [
							{
								role: 'assistant',
								content: [{ type: 'tool-call', toolCallId: 'tc-q', toolName: 'user_question', input: { question: 'Which framework?' } }],
							},
							{
								role: 'tool',
								content: [
									{
										type: 'tool-result',
										toolCallId: 'tc-q',
										toolName: 'user_question',
										output: { type: 'text', value: 'Question asked' },
									},
								],
							},
						],
					}),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
				} as any;
			});

			const service = createTestService();
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Build a website'), [makeUserMessage('Build a website')], abortController);
			const events = await collectEvents(stream);

			// Only one turn (the loop stops after user_question)
			const turnCompletes = events.filter((event) => event.type === 'turn-complete');
			expect(turnCompletes).toHaveLength(1);
		});
	});

	// ─── Logger lifecycle ──────────────────────────────────────────────────

	describe('logger lifecycle', () => {
		it('creates a logger accessible via getLogger()', async () => {
			const service = createTestService();
			const abortController = new AbortController();
			const stream = service.runAgentStream(makeModelMessages('Hello'), [makeUserMessage('Hello')], abortController);
			await collectEvents(stream);

			const logger = service.getLogger();
			expect(logger).toBeDefined();
			// Logger ID is a randomly generated string
			expect(typeof logger?.id).toBe('string');
			expect(logger?.id.length).toBeGreaterThan(0);
		});
	});
});
