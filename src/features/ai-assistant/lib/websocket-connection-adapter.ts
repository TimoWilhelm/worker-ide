/**
 * WebSocket-based ConnectionAdapter for TanStack AI's useChat.
 *
 * Instead of streaming AG-UI events over SSE, this adapter:
 * 1. Starts the agent via an HTTP POST to /api/ai/chat
 * 2. Receives AG-UI stream chunks via the project WebSocket (as CustomEvents)
 * 3. Yields each chunk to useChat's StreamProcessor
 *
 * Reconnection-aware: when `connect()` is called and the session is already
 * running in the AgentRunner DO, the adapter skips the POST and just listens
 * for WebSocket events. This allows `useChat` to process chunks normally —
 * building messages, firing onChunk, showing streaming text — even after a
 * page refresh or when switching to a running session from the history.
 *
 * Trigger reconnection by calling `useChat.reload()` after loading a running
 * session's history into the store.
 */

import { getBufferedEvents, startAgentChat } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { isNetworkError } from '@/lib/utils';

import type { AIModelId } from '@shared/constants';
import type { AgentMode } from '@shared/types';
import type { StreamChunk } from '@tanstack/ai';

/**
 * Timeout for stale session detection during reconnection (ms).
 * If the event buffer is empty (DO was evicted) and no live events arrive
 * within this window, assume the session is stale and stop listening.
 */
const RECONNECT_STALE_TIMEOUT_MS = 10_000;

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

// =============================================================================
// Shared event queue helpers
// =============================================================================

type QueueItem = { type: 'chunk'; chunk: StreamChunk; eventIndex: number } | { type: 'done' } | { type: 'error'; error: Error };

function createEventQueue() {
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

	return { queue, enqueue, waitForItem };
}

function createEventListeners(sessionId: string, enqueue: (item: QueueItem) => void, abortSignal?: AbortSignal) {
	const handleStreamEvent = (event: Event) => {
		if (!(event instanceof CustomEvent)) return;
		const detail: { sessionId?: string; chunk?: StreamChunk; index?: number } = event.detail;
		if (detail.sessionId !== sessionId) return;
		if (detail.chunk !== undefined) {
			enqueue({ type: 'chunk', chunk: detail.chunk, eventIndex: detail.index ?? -1 });
		}
	};

	const handleStatusChanged = (event: Event) => {
		if (!(event instanceof CustomEvent)) return;
		const detail: { sessionId?: string; status?: string } = event.detail;
		if (detail.sessionId !== sessionId) return;
		if (detail.status === 'completed' || detail.status === 'error' || detail.status === 'aborted') {
			enqueue({ type: 'done' });
		}
	};

	const handleAbort = () => {
		enqueue({ type: 'error', error: new DOMException('Aborted', 'AbortError') });
	};

	globalThis.addEventListener('agent-stream-event', handleStreamEvent);
	globalThis.addEventListener('agent-status-changed', handleStatusChanged);
	abortSignal?.addEventListener('abort', handleAbort);

	return () => {
		globalThis.removeEventListener('agent-stream-event', handleStreamEvent);
		globalThis.removeEventListener('agent-status-changed', handleStatusChanged);
		abortSignal?.removeEventListener('abort', handleAbort);
	};
}

async function* drainQueue(queue: QueueItem[], waitForItem: () => Promise<void>): AsyncGenerator<StreamChunk, void, unknown> {
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
}

// =============================================================================
// Connection Adapter
// =============================================================================

/**
 * Create a WebSocket-based ConnectionAdapter for useChat.
 *
 * The adapter is reconnection-aware: if the current session is already
 * running in the AgentRunner DO, it skips the HTTP POST and immediately
 * starts listening for stream events via WebSocket CustomEvents.
 *
 * For new sessions, it POSTs to /api/ai/chat to start the agent, then
 * listens for chunks the same way.
 */
export function createWebSocketConnectionAdapter(options: WebSocketAdapterOptions): ConnectionAdapter {
	return {
		async *connect(messages, _data, abortSignal) {
			const { projectId, getMode, getSessionId, getModel, getOutputLogs } = options;
			const currentSessionId = getSessionId();

			// Check if this session is already running in the DO.
			// If so, skip the POST and just listen (reconnection mode).
			const isAlreadyRunning = currentSessionId ? useStore.getState().runningSessionIds.has(currentSessionId) : false;

			let sessionId: string;

			if (isAlreadyRunning && currentSessionId) {
				// Reconnection: session is already running, just listen.
				sessionId = currentSessionId;

				// 1. Start listening for live events FIRST (so we don't miss any
				//    that arrive while we fetch the buffer).
				const { queue, enqueue, waitForItem } = createEventQueue();
				const cleanup = createEventListeners(sessionId, enqueue, abortSignal);

				try {
					// 2. Fetch buffered events from the DO to catch up.
					//    These are all events since index 0 (full replay).
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- chunk is StreamChunk from the DO buffer
					const buffered = (await getBufferedEvents(projectId, sessionId, 0)) as Array<{ chunk: StreamChunk; index: number }>;

					// 3. Yield buffered events first. The live listener may have
					//    already enqueued some events that overlap with the buffer.
					//    Track the highest buffered index to deduplicate.
					let highestBufferedIndex = -1;
					for (const event of buffered) {
						yield event.chunk;
						highestBufferedIndex = Math.max(highestBufferedIndex, event.index);
					}

					// 4. If the buffer was empty and no live events have arrived,
					//    the DO was likely evicted (in-memory buffer lost). Apply a
					//    timeout so we don't hang forever waiting for events that
					//    will never come.
					const needsStaleTimeout = buffered.length === 0 && queue.length === 0;

					// 5. Drain the live queue, skipping events already yielded
					//    from the buffer (deduplicate by event index).
					let receivedLiveEvent = false;
					while (true) {
						if (needsStaleTimeout && !receivedLiveEvent) {
							// Race waitForItem against a stale-session timeout.
							// If no event arrives within RECONNECT_STALE_TIMEOUT_MS,
							// assume the session is stale and stop listening.
							const timeout = new Promise<'timeout'>((resolve) => {
								setTimeout(() => resolve('timeout'), RECONNECT_STALE_TIMEOUT_MS);
							});
							const result = await Promise.race([waitForItem().then(() => 'item' as const), timeout]);
							if (result === 'timeout') {
								// Session is stale — signal completion to useChat
								return;
							}
						} else {
							await waitForItem();
						}

						while (queue.length > 0) {
							const item = queue.shift()!;

							if (item.type === 'error') {
								throw item.error;
							}

							if (item.type === 'done') {
								return;
							}

							// Skip events we already yielded from the buffer
							if (item.eventIndex >= 0 && item.eventIndex <= highestBufferedIndex) {
								continue;
							}

							receivedLiveEvent = true;
							yield item.chunk;
						}
					}
				} finally {
					cleanup();
				}
			} else {
				// New session: start the agent via HTTP POST
				try {
					const result = await startAgentChat(projectId, {
						messages,
						mode: getMode(),
						sessionId: currentSessionId,
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

				const { queue, enqueue, waitForItem } = createEventQueue();
				const cleanup = createEventListeners(sessionId, enqueue, abortSignal);

				try {
					yield* drainQueue(queue, waitForItem);
				} finally {
					cleanup();
				}
			}
		},
	};
}
