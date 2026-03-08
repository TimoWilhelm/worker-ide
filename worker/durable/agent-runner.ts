/**
 * Agent Runner Durable Object.
 *
 * Executes AI agent loops independently of client connections. This enables:
 * - Session generation continues even if the user disconnects
 * - Collaboration users can observe ongoing agent sessions in real-time
 * - Explicit abort via WebSocket message or RPC
 *
 * **Alarm-based resilience:** When a Durable Object is evicted mid-execution
 * (no shutdown hooks exist), in-memory state is lost. To survive this:
 * - Before starting an agent loop, parameters are persisted to `running:{sessionId}` KV
 * - A heartbeat alarm is set and periodically rescheduled while the loop runs
 * - On normal completion, the `running:` entry is deleted
 * - If the DO is evicted, the alarm fires on the new instance, finds the
 *   orphaned `running:` entry, and **restarts** the agent loop from scratch
 * - `getRunningSessionIds()` reads from durable `running:` KV, not volatile maps
 *
 * One instance per project, keyed by `agent:${projectId}`.
 * Communicates with ProjectCoordinator (for event broadcast) and
 * ExpiringFilesystem (for file operations) via RPC — no self-referential calls.
 */

import { convertMessagesToModelMessages } from '@tanstack/ai';
import { DurableObject, env } from 'cloudflare:workers';
import { mount, withMounts } from 'worker-fs-mount';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { AIAgentService } from '../services/ai-agent';
import { cleanupSessionArtifacts, cleanupTimestampPlans } from '../services/ai-agent/session-cleanup';

import type { AIModelId } from '@shared/constants';
import type { AgentSessionStatus, AiSession, PendingFileChange, UIMessage } from '@shared/types';

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
 * Maximum number of sessions to retain. When exceeded after a new session
 * is persisted, the oldest sessions (by createdAt) are pruned along with
 * all their filesystem artifacts (debug logs, filetime, plans, todos,
 * orphaned snapshots).
 */
const MAX_SESSIONS = 50;

/**
 * Heartbeat interval for the alarm-based resilience mechanism (ms).
 * While an agent loop is running, the alarm is rescheduled at this interval.
 * If the DO is evicted and the alarm fires without an active abort controller,
 * the agent loop is restarted from the persisted parameters.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Parameters for starting an agent run.
 */
export interface StartAgentParameters {
	projectId: string;
	messages: UIMessage[];
	mode?: 'code' | 'plan' | 'ask';
	sessionId?: string;
	model?: string;
	outputLogs?: string;
}

export class AgentRunner extends DurableObject {
	/**
	 * In-memory abort controllers keyed by sessionId.
	 * Volatile — lost on eviction. Used for graceful abort and to detect
	 * whether the current instance owns a running loop.
	 */
	private agentAbortControllers = new Map<string, AbortController>();

	/**
	 * Ring buffers of recent stream events for late-joining clients, keyed by sessionId.
	 * Volatile — lost on eviction. Reconnecting clients get an empty buffer
	 * and the stale-session timeout in the adapter handles the fallback.
	 */
	private eventBuffers = new Map<string, Array<{ chunk: object; index: number }>>();

	/**
	 * Monotonic event indices within the current agent run, keyed by sessionId.
	 * Volatile — reset when the loop starts.
	 */
	private eventIndices = new Map<string, number>();

	// =========================================================================
	// Alarm Handler — session resilience
	// =========================================================================

	/**
	 * Called by the runtime when the heartbeat alarm fires.
	 *
	 * If an agent loop is still actively running (abort controller exists),
	 * this is a no-op — the loop itself reschedules the alarm.
	 *
	 * If no abort controller exists but a `running:{sessionId}` KV entry
	 * is present, the DO was evicted mid-execution. Restart the loop from
	 * the persisted parameters.
	 */
	async alarm(): Promise<void> {
		const orphaned = this.getOrphanedRunningSessions();
		if (orphaned.length === 0) return;

		for (const { sessionId, parameters } of orphaned) {
			console.log(`[AgentRunner] Alarm: restarting evicted session ${sessionId}`);
			this.launchAgentLoop(parameters, sessionId);
			await this.broadcastStatusChanged(parameters.projectId, sessionId, 'running');
		}

		// Reschedule for any remaining sessions
		this.scheduleHeartbeatAlarm();
	}

	// =========================================================================
	// RPC Methods
	// =========================================================================

	/**
	 * Start an AI agent run. Returns immediately with the session ID.
	 * The agent loop continues running asynchronously within the DO.
	 *
	 * Dedup: if `running:{sessionId}` KV already exists, the session is
	 * either actively running or will be restarted by the alarm. In either
	 * case, we return without launching a duplicate loop.
	 */
	async startAgent(parameters: StartAgentParameters): Promise<{ sessionId: string }> {
		const sessionId = parameters.sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

		// Already tracked as running (durable check — survives eviction)
		if (this.ctx.storage.kv.get(`running:${sessionId}`) !== undefined) {
			return { sessionId };
		}

		// Persist restart parameters BEFORE launching so the alarm can recover
		this.ctx.storage.kv.put(`running:${sessionId}`, parameters);

		this.launchAgentLoop(parameters, sessionId);

		// Broadcast the status change to all connected clients
		await this.broadcastStatusChanged(parameters.projectId, sessionId, 'running');

		// Set the heartbeat alarm
		this.scheduleHeartbeatAlarm();

		return { sessionId };
	}

	/**
	 * Abort the currently running agent or a specific agent session.
	 *
	 * If the loop is active in this instance, the abort controller is signaled
	 * and the `finally` block handles cleanup + broadcast.
	 *
	 * If the loop is NOT active (post-eviction, pre-alarm), we delete the
	 * durable `running:` marker to prevent alarm restart and broadcast
	 * the abort status directly.
	 */
	async abortAgent(sessionId?: string): Promise<void> {
		if (sessionId) {
			const controller = this.agentAbortControllers.get(sessionId);
			if (controller) {
				// Active loop — abort it; the finally block handles broadcast
				controller.abort();
				this.agentAbortControllers.delete(sessionId);
			}
			// Remove the durable marker — prevents alarm from restarting
			const parameters = this.ctx.storage.kv.get<StartAgentParameters>(`running:${sessionId}`);
			this.ctx.storage.kv.delete(`running:${sessionId}`);

			// If no active loop, broadcast abort directly (the finally block won't run)
			if (!controller && parameters) {
				await this.broadcastStatusChanged(parameters.projectId, sessionId, 'aborted');
			}
		} else {
			// Abort all running agents
			const activeIds = new Set(this.agentAbortControllers.keys());
			for (const controller of this.agentAbortControllers.values()) {
				controller.abort();
			}
			this.agentAbortControllers.clear();

			// Remove all durable running markers and broadcast for orphaned ones
			for (const [key, parameters] of this.ctx.storage.kv.list<StartAgentParameters>({ prefix: 'running:' })) {
				const id = key.slice('running:'.length);
				this.ctx.storage.kv.delete(key);
				// Broadcast for sessions that had no active loop
				if (!activeIds.has(id)) {
					await this.broadcastStatusChanged(parameters.projectId, id, 'aborted');
				}
			}
		}
	}

	/**
	 * Get the IDs of all sessions that are currently running.
	 *
	 * Reads from durable `running:{sessionId}` KV entries, which survive
	 * DO eviction. This is the source of truth for "is something running?"
	 */
	async getRunningSessionIds(): Promise<string[]> {
		const ids: string[] = [];
		for (const [key] of this.ctx.storage.kv.list({ prefix: 'running:' })) {
			ids.push(key.slice('running:'.length));
		}
		return ids;
	}

	/**
	 * Get buffered events since a given index for reconnection.
	 * Returns events with index > lastEventIndex.
	 *
	 * After DO eviction the buffer is empty — the reconnecting client's
	 * stale-session timeout handles this gracefully.
	 */
	async getBufferedEvents(sessionId: string, lastEventIndex: number): Promise<Array<{ chunk: object; index: number }>> {
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
		const runningIds = new Set(await this.getRunningSessionIds());
		const sessions: Array<{ id: string; title: string; createdAt: number; isRunning: boolean }> = [];
		const entries = this.ctx.storage.kv.list<AiSession>({ prefix: 'sessionData:' });
		for (const [, data] of entries) {
			if (data && typeof data.title === 'string' && typeof data.createdAt === 'number') {
				sessions.push({
					id: data.id,
					title: data.title,
					createdAt: data.createdAt,
					isRunning: runningIds.has(data.id),
				});
			}
		}
		sessions.sort((a, b) => b.createdAt - a.createdAt);
		return sessions;
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
			return;
		}

		const session = this.ctx.storage.kv.get<AiSession>(`sessionData:${sessionId}`);
		if (!session) return;

		// Truncate history and prune snapshot/mode mappings above the cut point
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
		let prunedModes: Record<string, string> | undefined;
		if (session.messageModes) {
			prunedModes = {};
			for (const [key, value] of Object.entries(session.messageModes)) {
				if (Number(key) < messageIndex) {
					prunedModes[key] = value;
				}
			}
			if (Object.keys(prunedModes).length === 0) {
				prunedModes = undefined;
			}
		}

		this.ctx.storage.kv.put(`sessionData:${sessionId}`, {
			...session,
			history: truncatedHistory,
			messageSnapshots: prunedSnapshots,
			messageModes: prunedModes,
			revertedAt: Date.now(),
		});
	}

	/**
	 * Delete a session and all its associated artifacts.
	 */
	async deleteSession(projectId: string, sessionId: string): Promise<void> {
		this.ctx.storage.kv.delete(`sessionData:${sessionId}`);

		this.removePendingChangesForSessions(new Set([sessionId]));
		const survivingSnapshotIds = this.getSurvivingSnapshotIds();

		try {
			const fsId = filesystemNamespace.idFromString(projectId);
			const fsStub = filesystemNamespace.get(fsId);

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				await cleanupSessionArtifacts(PROJECT_ROOT, new Set([sessionId]), survivingSnapshotIds);
			});
		} catch (error) {
			console.error('[AgentRunner] Failed to clean up filesystem artifacts for deleted session:', error);
		}
	}

	// =========================================================================
	// Session Pruning
	// =========================================================================

	/**
	 * Prune sessions beyond the rolling limit.
	 *
	 * Deletes the oldest sessions (by createdAt) that exceed MAX_SESSIONS,
	 * skipping any that are currently running. Also cleans up:
	 * - KV: sessionData, pending changes entries
	 * - Filesystem: .agent/sessions/{id}/, .agent/todo/{id}.json,
	 *   .agent/plans/{id}.md, orphaned snapshots
	 *
	 * Called after each agent run completes in executeAgentLoop.
	 */
	private async pruneOldSessions(projectId: string): Promise<void> {
		// Collect all sessions sorted by createdAt descending
		const allSessions: Array<{ id: string; createdAt: number }> = [];
		const entries = this.ctx.storage.kv.list<AiSession>({ prefix: 'sessionData:' });
		for (const [, data] of entries) {
			if (data?.id && typeof data.createdAt === 'number') {
				allSessions.push({ id: data.id, createdAt: data.createdAt });
			}
		}
		allSessions.sort((a, b) => b.createdAt - a.createdAt);

		if (allSessions.length <= MAX_SESSIONS) return;

		// Identify sessions to prune (oldest beyond the limit, skipping running ones)
		const runningIds = new Set(await this.getRunningSessionIds());
		const sessionsToPrune: string[] = [];
		for (const session of allSessions.slice(MAX_SESSIONS)) {
			if (!runningIds.has(session.id)) {
				sessionsToPrune.push(session.id);
			}
		}

		if (sessionsToPrune.length === 0) return;

		const prunedSessionIds = new Set(sessionsToPrune);

		// --- KV Cleanup ---
		for (const sessionId of sessionsToPrune) {
			this.ctx.storage.kv.delete(`sessionData:${sessionId}`);
		}

		// Remove pending changes belonging to pruned sessions.
		// Pending changes are NOT auto-accepted — they are simply discarded.
		this.removePendingChangesForSessions(prunedSessionIds);
		const survivingSnapshotIds = this.getSurvivingSnapshotIds();

		// --- Filesystem Cleanup ---
		try {
			const fsId = filesystemNamespace.idFromString(projectId);
			const fsStub = filesystemNamespace.get(fsId);

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				await cleanupSessionArtifacts(PROJECT_ROOT, prunedSessionIds, survivingSnapshotIds);
				await cleanupTimestampPlans(PROJECT_ROOT);
			});
		} catch (error) {
			// Non-fatal — KV cleanup already succeeded, filesystem is best-effort
			console.error('[AgentRunner] Failed to clean up filesystem artifacts:', error);
		}
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
	// Agent Loop Lifecycle
	// =========================================================================

	/**
	 * Prepare in-memory state and launch the agent loop asynchronously.
	 * Does not block — the caller should broadcast status after calling this.
	 */
	private launchAgentLoop(parameters: StartAgentParameters, sessionId: string): void {
		// Reset event buffer for the new run
		this.eventBuffers.set(sessionId, []);
		this.eventIndices.set(sessionId, 0);

		// Clear the revertedAt flag so that persist callbacks from this new run
		// are not blocked. revertedAt is set by revertSession() to prevent a
		// stale in-flight run's finally block from overwriting a reverted session.
		const existingSession = this.ctx.storage.kv.get<AiSession>(`sessionData:${sessionId}`);
		if (existingSession?.revertedAt) {
			this.ctx.storage.kv.put(`sessionData:${sessionId}`, { ...existingSession, revertedAt: undefined });
		}

		// Early-persist the session with the incoming messages so that a
		// reconnecting client (e.g. browser back/forward) sees the full
		// conversation history even if the agent loop hasn't persisted yet.
		const incomingHistory = parameters.messages;
		const emptySession: Partial<AiSession> = {};
		const base = existingSession ?? emptySession;

		// Derive a placeholder title from the last user message until the AI generates a proper one
		const lastUserMessage = parameters.messages.toReversed().find((message) => message.role === 'user');
		const firstTextPart = lastUserMessage?.parts.find((part) => part.type === 'text');
		const promptPreview = (firstTextPart?.type === 'text' ? firstTextPart.content.slice(0, 80) : undefined) || 'New session';

		this.ctx.storage.kv.put(`sessionData:${sessionId}`, {
			...base,
			id: sessionId,
			title: base.title ?? promptPreview,
			createdAt: base.createdAt ?? Date.now(),
			history: incomingHistory,
			revertedAt: undefined,
		});

		// Create a new abort controller for this run
		this.agentAbortControllers.set(sessionId, new AbortController());

		// Start the agent loop asynchronously — does not block the RPC response.
		// The DO stays alive as long as this async work is in progress.
		this.ctx.waitUntil(
			this.executeAgentLoop(parameters, sessionId).catch((error) => {
				console.error(`[AgentRunner ${sessionId}] Unhandled error from executeAgentLoop:`, error);
			}),
		);
	}

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
			const modelMessages = convertMessagesToModelMessages(parameters.messages);

			const agentService = new AIAgentService(
				PROJECT_ROOT,
				projectId,
				fsStub,
				sessionId,
				mode,
				model,
				async (sid, sessionData, pendingChanges) => {
					// Merge with existing session data to preserve fields from prior turns
					// (createdAt, messageSnapshots, title, toolMetadata, toolErrors).
					// The service sends only the current turn's data for these fields.
					const existing = this.ctx.storage.kv.get<AiSession>(`sessionData:${sid}`);

					// Preserve the original creation timestamp
					const createdAt = existing?.createdAt ?? sessionData.createdAt;

					// Preserve the AI-generated title once set (don't regress to fallback)
					const title = existing?.title ?? sessionData.title;

					// Merge messageSnapshots: existing + current turn's new entry
					const messageSnapshots =
						existing?.messageSnapshots || sessionData.messageSnapshots
							? { ...existing?.messageSnapshots, ...sessionData.messageSnapshots }
							: undefined;

					// Merge messageModes: existing + current turn's new entry
					const messageModes =
						existing?.messageModes || sessionData.messageModes ? { ...existing?.messageModes, ...sessionData.messageModes } : undefined;

					// Merge tool metadata and errors: existing + current turn's new entries
					const toolMetadata =
						existing?.toolMetadata || sessionData.toolMetadata ? { ...existing?.toolMetadata, ...sessionData.toolMetadata } : undefined;
					const toolErrors =
						existing?.toolErrors || sessionData.toolErrors ? { ...existing?.toolErrors, ...sessionData.toolErrors } : undefined;

					// If the session was reverted while the agent was running,
					// skip this persist to avoid overwriting the truncated history.
					// The revertedAt flag is cleared on the next user-initiated run.
					if (existing?.revertedAt) {
						return;
					}

					this.ctx.storage.kv.put(`sessionData:${sid}`, {
						...sessionData,
						id: sid,
						createdAt,
						title,
						messageSnapshots,
						messageModes,
						toolMetadata,
						toolErrors,
					});

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

			// Track last heartbeat reschedule to throttle alarm writes
			let lastHeartbeat = Date.now();

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

				// Reschedule heartbeat alarm periodically (throttled)
				const now = Date.now();
				if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
					lastHeartbeat = now;
					this.scheduleHeartbeatAlarm();
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
			// Remove the durable running marker — this session completed
			this.ctx.storage.kv.delete(`running:${sessionId}`);

			// Clean up in-memory state
			this.agentAbortControllers.delete(sessionId);
			this.eventBuffers.delete(sessionId);
			this.eventIndices.delete(sessionId);

			// Broadcast the final status (with sanitized error message if applicable)
			await this.broadcastStatusChanged(parameters.projectId, sessionId, finalStatus, undefined, errorMessage).catch(() => {});

			// Prune old sessions beyond the rolling limit (best-effort, non-blocking)
			await this.pruneOldSessions(projectId).catch((error) => {
				console.error('[AgentRunner] Session pruning failed:', error);
			});
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
	// Alarm Helpers
	// =========================================================================

	/**
	 * Schedule (or reschedule) the heartbeat alarm.
	 * Only one alarm can exist per DO — each call replaces the previous one.
	 */
	private scheduleHeartbeatAlarm(): void {
		void this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
	}

	/**
	 * Find `running:{sessionId}` entries that have no in-memory abort controller.
	 * These represent sessions that were interrupted by DO eviction.
	 */
	private getOrphanedRunningSessions(): Array<{ sessionId: string; parameters: StartAgentParameters }> {
		const orphaned: Array<{ sessionId: string; parameters: StartAgentParameters }> = [];
		for (const [key, parameters] of this.ctx.storage.kv.list<StartAgentParameters>({ prefix: 'running:' })) {
			const sessionId = key.slice('running:'.length);
			if (!this.agentAbortControllers.has(sessionId)) {
				orphaned.push({ sessionId, parameters });
			}
		}
		return orphaned;
	}

	// =========================================================================
	// Storage Helpers
	// =========================================================================

	/**
	 * Remove pending change entries belonging to the given session IDs.
	 * Pending changes are NOT auto-accepted — they are simply discarded.
	 */
	private removePendingChangesForSessions(sessionIds: Set<string>): void {
		const raw = this.ctx.storage.kv.get<string>('pendingChanges');
		if (!raw) return;

		try {
			const parsed: Record<string, PendingFileChange> = JSON.parse(raw);
			let changed = false;
			for (const [path, change] of Object.entries(parsed)) {
				if (sessionIds.has(change.sessionId)) {
					delete parsed[path];
					changed = true;
				}
			}
			if (changed) {
				if (Object.keys(parsed).length === 0) {
					this.ctx.storage.kv.delete('pendingChanges');
				} else {
					this.ctx.storage.kv.put('pendingChanges', JSON.stringify(parsed));
				}
			}
		} catch {
			// Malformed JSON — leave it alone
		}
	}

	/**
	 * Collect snapshot IDs still referenced by surviving pending changes.
	 * These must not be deleted during filesystem cleanup.
	 */
	private getSurvivingSnapshotIds(): Set<string> {
		const surviving = new Set<string>();
		const raw = this.ctx.storage.kv.get<string>('pendingChanges');
		if (!raw) return surviving;

		try {
			const parsed: Record<string, { snapshotId?: string }> = JSON.parse(raw);
			for (const change of Object.values(parsed)) {
				if (change.snapshotId) {
					surviving.add(change.snapshotId);
				}
			}
		} catch {
			// Ignore
		}
		return surviving;
	}
}
