/**
 * Agent Runner Durable Object.
 *
 * Executes AI agent loops independently of client connections. This enables:
 * - Session generation continues even if the user disconnects
 * - Collaboration users can observe ongoing agent sessions in real-time
 * - Explicit abort via WebSocket message or RPC
 *
 * One instance per project, keyed by `agent:${projectId}`.
 * Communicates with ProjectCoordinator (for event broadcast) and
 * ExpiringFilesystem (for file operations) via RPC — no self-referential calls.
 */

import { convertMessagesToModelMessages } from '@tanstack/ai';
import { DurableObject, env } from 'cloudflare:workers';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { AIAgentService } from '../services/ai-agent';

import type { AIModelId } from '@shared/constants';
import type { ActiveAgentSession, AgentSessionStatus, AiSession } from '@shared/types';

/**
 * Maximum number of recent stream events to buffer for reconnection.
 * Late-joining clients receive these events to catch up.
 */
const EVENT_BUFFER_CAPACITY = 500;

/**
 * Project root path used by the filesystem mount.
 */
const PROJECT_ROOT = '/project';

/**
 * Parameters for starting an agent run.
 */
export interface StartAgentParameters {
	projectId: string;
	messages: unknown[];
	mode?: 'code' | 'plan' | 'ask';
	sessionId?: string;
	model?: string;
	outputLogs?: string;
}

export class AgentRunner extends DurableObject {
	/**
	 * In-memory abort controllers keyed by sessionId
	 */
	private agentAbortControllers = new Map<string, AbortController>();

	/**
	 * Ring buffers of recent stream events for late-joining clients, keyed by sessionId.
	 */
	private eventBuffers = new Map<string, Array<{ chunk: unknown; index: number }>>();

	/**
	 * Monotonic event indices within the current agent run, keyed by sessionId.
	 */
	private eventIndices = new Map<string, number>();

	// =========================================================================
	// RPC Methods
	// =========================================================================

	/**
	 * Start an AI agent run. Returns immediately with the session state.
	 * The agent loop continues running asynchronously within the DO.
	 *
	 * If an agent is already running, returns the existing session state
	 * without starting a new one.
	 */
	async startAgent(parameters: StartAgentParameters): Promise<ActiveAgentSession> {
		const sessionId = parameters.sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
		const existing = this.getActiveSession(sessionId);

		// If the session claims to be running, but we don't have an abort controller
		// in memory, the DO was evicted or crashed. Treat it as not running.
		if (existing?.status === 'running' && this.agentAbortControllers.has(sessionId)) {
			return existing;
		}

		const session: ActiveAgentSession = {
			sessionId,
			status: 'running',
			startedAt: Date.now(),
		};

		this.setActiveSession(sessionId, session);

		// Reset event buffer for the new run
		this.eventBuffers.set(sessionId, []);
		this.eventIndices.set(sessionId, 0);

		// Create a new abort controller for this run
		this.agentAbortControllers.set(sessionId, new AbortController());

		// Start the agent loop asynchronously — does not block the RPC response.
		// The DO stays alive as long as this async work is in progress.
		this.ctx.waitUntil(
			this.executeAgentLoop(parameters, sessionId).catch((error) => {
				console.error(`[AgentRunner ${sessionId}] Unhandled error from executeAgentLoop:`, error);
			}),
		);

		// Broadcast the status change to all connected clients
		await this.broadcastStatusChanged(parameters.projectId, sessionId, 'running');

		return session;
	}

	/**
	 * Abort the currently running agent or a specific agent session.
	 */
	async abortAgent(sessionId?: string): Promise<void> {
		if (sessionId) {
			const controller = this.agentAbortControllers.get(sessionId);
			if (controller) {
				controller.abort();
				this.agentAbortControllers.delete(sessionId);
			}
		} else {
			// Abort all running agents
			for (const controller of this.agentAbortControllers.values()) {
				controller.abort();
			}
			this.agentAbortControllers.clear();
		}
	}

	/**
	 * Get the current agent session state for a specific ID,
	 * or the most recently started active session if no ID is specified.
	 */
	async getAgentStatus(sessionId?: string): Promise<ActiveAgentSession | undefined> {
		if (sessionId) {
			return this.getActiveSession(sessionId);
		}

		// Fallback: get the latest running session
		const sessions = this.ctx.storage.kv.list<ActiveAgentSession>({ prefix: 'session:' });

		const activeSessions: ActiveAgentSession[] = [];
		for (const [_, session] of sessions) {
			if (session.status === 'running') {
				activeSessions.push(session);
			}
		}

		activeSessions.sort((a, b) => b.startedAt - a.startedAt);

		return activeSessions[0];
	}

	/**
	 * Get the IDs of all sessions that are currently running.
	 * Only returns sessions that have an in-memory abort controller
	 * (i.e. genuinely active, not stale from a DO eviction).
	 */
	async getRunningSessionIds(): Promise<string[]> {
		return [...this.agentAbortControllers.keys()];
	}

	/**
	 * Get buffered events since a given index for reconnection.
	 * Returns events with index > lastEventIndex.
	 */
	async getBufferedEvents(sessionId: string, lastEventIndex: number): Promise<Array<{ chunk: unknown; index: number }>> {
		const buffer = this.eventBuffers.get(sessionId) || [];
		return buffer.filter((event) => event.index > lastEventIndex);
	}

	// =========================================================================
	// Session CRUD
	// =========================================================================

	/**
	 * List all saved sessions (summary only: id, title, createdAt).
	 */
	async listSessions(): Promise<Array<{ id: string; title: string; createdAt: number; isRunning: boolean }>> {
		const sessions: Array<{ id: string; title: string; createdAt: number; isRunning: boolean }> = [];
		const entries = this.ctx.storage.kv.list<AiSession>({ prefix: 'sessionData:' });
		for (const [, data] of entries) {
			if (data && typeof data.title === 'string' && typeof data.createdAt === 'number') {
				sessions.push({
					id: data.id,
					title: data.title,
					createdAt: data.createdAt,
					isRunning: this.agentAbortControllers.has(data.id),
				});
			}
		}
		sessions.sort((a, b) => b.createdAt - a.createdAt);
		return sessions.slice(0, 100);
	}

	/**
	 * Load a single session by ID.
	 */
	async loadSession(sessionId: string): Promise<AiSession | undefined> {
		return this.ctx.storage.kv.get<AiSession>(`sessionData:${sessionId}`);
	}

	/**
	 * Revert a session by truncating history to a given message index.
	 * Sets `revertedAt` to prevent the server-side stream `finally` block
	 * from overwriting the truncated history with the pre-revert version.
	 *
	 * If `messageIndex` is 0, deletes the session entirely.
	 */
	async revertSession(sessionId: string, messageIndex: number): Promise<void> {
		if (messageIndex <= 0) {
			// Full revert — delete the session
			this.ctx.storage.kv.delete(`sessionData:${sessionId}`);
			this.ctx.storage.kv.delete(`session:${sessionId}`);
			return;
		}

		const session = this.ctx.storage.kv.get<AiSession>(`sessionData:${sessionId}`);
		if (!session) return;

		// Truncate history and prune snapshot mappings above the cut point
		const truncatedHistory = session.history.slice(0, messageIndex);
		let prunedSnapshots: Record<string, string> | undefined;
		if (session.messageSnapshots) {
			prunedSnapshots = {};
			for (const [key, value] of Object.entries(session.messageSnapshots)) {
				if (Number(key) < messageIndex) {
					prunedSnapshots[key] = value;
				}
			}
			if (Object.keys(prunedSnapshots).length === 0) {
				prunedSnapshots = undefined;
			}
		}

		this.ctx.storage.kv.put(`sessionData:${sessionId}`, {
			...session,
			history: truncatedHistory,
			messageSnapshots: prunedSnapshots,
			revertedAt: Date.now(),
		});
	}

	/**
	 * Delete a session.
	 */
	async deleteSession(sessionId: string): Promise<void> {
		this.ctx.storage.kv.delete(`sessionData:${sessionId}`);
		// Also clean up the active session marker if it exists
		this.ctx.storage.kv.delete(`session:${sessionId}`);
	}

	// =========================================================================
	// Pending Changes
	// =========================================================================

	/**
	 * Load project-level pending changes.
	 */
	async loadPendingChanges(): Promise<Record<string, unknown>> {
		const raw = this.ctx.storage.kv.get<string>('pendingChanges');
		if (!raw) return {};
		try {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSON parse returns unknown
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	/**
	 * Save project-level pending changes.
	 */
	async savePendingChanges(changes: Record<string, unknown>): Promise<void> {
		this.ctx.storage.kv.put('pendingChanges', JSON.stringify(changes));
	}

	// =========================================================================
	// Agent Loop Execution
	// =========================================================================

	private async executeAgentLoop(parameters: StartAgentParameters, sessionId: string): Promise<void> {
		const projectId = parameters.projectId;
		let finalStatus: AgentSessionStatus = 'completed';
		let errorMessage: string | undefined;

		try {
			const apiToken = env.REPLICATE_API_TOKEN;
			if (!apiToken) {
				throw new Error('REPLICATE_API_TOKEN not configured');
			}

			// Get the filesystem stub for this project
			const fsId = filesystemNamespace.idFromString(projectId);
			const fsStub = filesystemNamespace.get(fsId);

			const mode = parameters.mode ?? 'code';
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- model ID validated upstream
			const model = (parameters.model ?? DEFAULT_AI_MODEL) as AIModelId;

			// Convert UIMessage[] to ModelMessage[]
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- UIMessage format from frontend is loosely typed at the wire boundary
			const modelMessages = convertMessagesToModelMessages(parameters.messages as any);

			const agentService = new AIAgentService(
				PROJECT_ROOT,
				projectId,
				fsStub,
				sessionId,
				mode,
				model,
				async (sid, sessionData, pendingChanges) => {
					// Persist session history metadata to DO storage
					this.ctx.storage.kv.put(`sessionData:${sid}`, { ...sessionData, id: sid });

					// Merge project-wide pending changes
					if (pendingChanges) {
						const existingString = this.ctx.storage.kv.get<string | undefined>('pendingChanges');
						let existing = {};
						if (existingString) {
							try {
								existing = JSON.parse(existingString);
							} catch {
								// Ignore invalid JSON
							}
						}

						this.ctx.storage.kv.put(
							'pendingChanges',
							JSON.stringify({
								...existing,
								...pendingChanges,
							}),
						);
					}
				},
			);

			// runAgentStream handles filesystem mounting internally via
			// a withMounts-scoped async producer piped through a TransformStream.
			const abortController = this.agentAbortControllers.get(sessionId) ?? new AbortController();
			const stream = agentService.runAgentStream(modelMessages, parameters.messages, apiToken, abortController, parameters.outputLogs);

			// Get the coordinator stub for broadcasting events
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);

			// Consume the stream and broadcast each chunk
			for await (const chunk of stream) {
				const index = this.eventIndices.get(sessionId) ?? 0;
				this.eventIndices.set(sessionId, index + 1);

				// Buffer the event for late-joining clients
				const buffer = this.eventBuffers.get(sessionId) ?? [];
				this.eventBuffers.set(sessionId, buffer);
				buffer.push({ chunk, index });
				if (buffer.length > EVENT_BUFFER_CAPACITY) {
					buffer.shift();
				}

				// Broadcast to all connected WebSocket clients via the coordinator
				try {
					await coordinatorStub.sendMessage({
						type: 'agent-stream-event',
						sessionId,
						chunk,
						index,
					});
				} catch {
					// Non-fatal: if the coordinator is unavailable, the event
					// is still buffered for reconnection
				}
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				finalStatus = 'aborted';
			} else {
				finalStatus = 'error';
				console.error(`Agent loop error in AgentRunner DO [${sessionId}]:`, error);

				// Emit a RUN_ERROR chunk so the UI shows an error message.
				// Sanitize: never expose internal error details to clients.
				const sanitizedMessage =
					error instanceof Error && error.message === 'REPLICATE_API_TOKEN not configured'
						? 'AI service is not configured. Please contact the project owner.'
						: 'An unexpected error occurred during generation. Please try again.';
				errorMessage = sanitizedMessage;

				const errorChunk = {
					type: 'RUN_ERROR',
					timestamp: Date.now(),
					error: { message: sanitizedMessage },
				};

				// Buffer and broadcast the error chunk so all clients see it
				const index = this.eventIndices.get(sessionId) ?? 0;
				this.eventIndices.set(sessionId, index + 1);
				const buffer = this.eventBuffers.get(sessionId) ?? [];
				this.eventBuffers.set(sessionId, buffer);
				buffer.push({ chunk: errorChunk, index });

				try {
					const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
					const coordinatorStub = coordinatorNamespace.get(coordinatorId);
					await coordinatorStub.sendMessage({
						type: 'agent-stream-event',
						sessionId,
						chunk: errorChunk,
						index,
					});
				} catch {
					// Non-fatal
				}
			}
		} finally {
			// Update the active session status
			const session = this.getActiveSession(sessionId);
			if (session) {
				session.status = finalStatus;
				this.setActiveSession(sessionId, session);
			}

			// Clean up
			this.agentAbortControllers.delete(sessionId);
			this.eventBuffers.delete(sessionId);
			this.eventIndices.delete(sessionId);

			// Broadcast the final status (with sanitized error message if applicable)
			await this.broadcastStatusChanged(parameters.projectId, sessionId, finalStatus, undefined, errorMessage).catch(() => {});
		}
	}

	// =========================================================================
	// Status Broadcasting
	// =========================================================================

	private async broadcastStatusChanged(
		projectId: string,
		sessionId: string,
		status: AgentSessionStatus,
		title?: string,
		errorMessage?: string,
	): Promise<void> {
		try {
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
			await coordinatorStub.sendMessage({
				type: 'agent-status-changed',
				sessionId,
				status,
				title,
				...(errorMessage ? { errorMessage } : {}),
			});
		} catch {
			// Non-fatal
		}
	}

	// =========================================================================
	// Storage Helpers
	// =========================================================================

	private getActiveSession(sessionId: string): ActiveAgentSession | undefined {
		return this.ctx.storage.kv.get<ActiveAgentSession>(`session:${sessionId}`);
	}

	private setActiveSession(sessionId: string, session: ActiveAgentSession | undefined): void {
		if (session === undefined) {
			this.ctx.storage.kv.delete(`session:${sessionId}`);
		} else {
			this.ctx.storage.kv.put(`session:${sessionId}`, session);
		}
	}
}
