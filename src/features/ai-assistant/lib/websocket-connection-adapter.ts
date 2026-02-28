/**
 * WebSocket-based ConnectionAdapter for TanStack AI's useChat.
 *
 * Instead of streaming AG-UI events over SSE, this adapter:
 * 1. Starts the agent via an HTTP POST to /api/ai/chat
 * 2. Receives AG-UI stream chunks via the project WebSocket (as CustomEvents)
 * 3. Yields each chunk to useChat's StreamProcessor
 *
 * This enables disconnect-resilient agent sessions: the AgentRunner DO
 * continues running even if the browser disconnects. Reconnecting clients
 * catch up via buffered events.
 */

import { startAgentChat } from '@/lib/api-client';
import { isNetworkError } from '@/lib/utils';

import type { AIModelId } from '@shared/constants';
import type { AgentMode } from '@shared/types';
import type { StreamChunk } from '@tanstack/ai';

/**
 * Options for the WebSocket connection adapter.
 */
interface WebSocketAdapterOptions {
	projectId: string;
	/** Returns the current agent mode at request time */
	getMode: () => AgentMode;
	/** Returns the current session ID at request time */
	getSessionId: () => string | undefined;
	/** Returns the current model ID at request time */
	getModel: () => AIModelId;
	/** Returns the current output logs snapshot at request time */
	getOutputLogs: () => string;
}

/**
 * ConnectionAdapter interface matching @tanstack/ai-client.
 * We define it here to avoid importing internal types.
 */
export interface ConnectionAdapter {
	connect: (messages: Array<unknown>, data?: Record<string, unknown>, abortSignal?: AbortSignal) => AsyncIterable<StreamChunk>;
}

/**
 * Create a WebSocket-based ConnectionAdapter for useChat.
 *
 * The adapter POSTs to the AI chat endpoint to start the agent,
 * then yields AG-UI stream chunks received via CustomEvents from
 * the project WebSocket connection.
 */
export function createWebSocketConnectionAdapter(options: WebSocketAdapterOptions): ConnectionAdapter {
	return {
		async *connect(messages, _data, abortSignal) {
			const { projectId, getMode, getSessionId, getModel, getOutputLogs } = options;

			// Start the agent run via HTTP POST (returns immediately)
			let sessionId: string;
			try {
				const result = await startAgentChat(projectId, {
					messages,
					mode: getMode(),
					sessionId: getSessionId(),
					model: getModel(),
					outputLogs: getOutputLogs(),
				});
				sessionId = result.sessionId;
			} catch (error) {
				if (isNetworkError(error)) {
					throw new Error('Unable to connect. Check your internet connection and try again.');
				}
				throw error;
			}

			// Create a queue for incoming stream chunks
			type QueueItem = { type: 'chunk'; chunk: StreamChunk } | { type: 'done' } | { type: 'error'; error: Error };
			const queue: QueueItem[] = [];
			let resolve: (() => void) | undefined;

			const enqueue = (item: QueueItem) => {
				queue.push(item);
				if (resolve) {
					resolve();
					resolve = undefined;
				}
			};

			const waitForItem = (): Promise<void> => {
				if (queue.length > 0) return Promise.resolve();
				return new Promise<void>((r) => {
					resolve = r;
				});
			};

			// Listen for AG-UI stream chunks from the project WebSocket.
			// CustomEvent detail is typed as `any` by the DOM spec — we extract
			// fields via property access to avoid `as` assertions.
			const handleStreamEvent = (event: Event) => {
				if (!(event instanceof CustomEvent)) return;
				const detail: { sessionId?: string; chunk?: StreamChunk } = event.detail;
				if (detail.sessionId !== sessionId) return;
				if (detail.chunk !== undefined) {
					enqueue({ type: 'chunk', chunk: detail.chunk });
				}
			};

			// Listen for agent status changes (completion/error/abort)
			const handleStatusChanged = (event: Event) => {
				if (!(event instanceof CustomEvent)) return;
				const detail: { sessionId?: string; status?: string } = event.detail;
				if (detail.sessionId !== sessionId) return;
				if (detail.status === 'completed' || detail.status === 'error' || detail.status === 'aborted') {
					enqueue({ type: 'done' });
				}
			};

			// Handle abort signal
			const handleAbort = () => {
				enqueue({ type: 'error', error: new DOMException('Aborted', 'AbortError') });
			};

			globalThis.addEventListener('agent-stream-event', handleStreamEvent);
			globalThis.addEventListener('agent-status-changed', handleStatusChanged);
			abortSignal?.addEventListener('abort', handleAbort);

			try {
				// Yield chunks as they arrive
				while (true) {
					await waitForItem();

					while (queue.length > 0) {
						const item = queue.shift()!;

						if (item.type === 'error') {
							throw item.error;
						}

						if (item.type === 'done') {
							return;
						}

						yield item.chunk;
					}
				}
			} finally {
				globalThis.removeEventListener('agent-stream-event', handleStreamEvent);
				globalThis.removeEventListener('agent-status-changed', handleStatusChanged);
				abortSignal?.removeEventListener('abort', handleAbort);
			}
		},
	};
}
