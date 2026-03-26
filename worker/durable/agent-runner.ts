/**
 * Agent Runner Durable Object.
 *
 * Extends the Agents SDK `Agent` class for:
 * - **Automatic state sync** — `this.state` is SQLite-backed and auto-broadcast
 *   to all connected WebSocket clients (the frontend's `useAgent` hook).
 * - **@callable RPC** — Methods decorated with `callable` are invokable
 *   over WebSocket from the client via `agent.call()`.
 * - **Streaming RPC** — `@callable({ streaming: true })` for real-time generation
 *   streaming to clients.
 * - **Eviction recovery** — `onStart()` lifecycle hook detects orphaned runs and
 *   restarts them (replaces the manual alarm-based heartbeat mechanism).
 *
 * Architecture:
 * - The Agent owns all AI session state. The frontend is a pure renderer.
 * - Streaming content flows via `@callable({ streaming: true })` RPC.
 * - Session metadata (messages, status, tool data) flows via `this.setState()`.
 * - One instance per project, named `agent:${projectId}`.
 * - Communicates with ProjectCoordinator (for file change HMR triggers) and
 *   ExpiringFilesystem (for file operations) via DO RPC stubs.
 *
 * Database access uses Drizzle ORM (`drizzle-orm/durable-sqlite`) for all
 * custom tables. The Agent SDK's internal tables remain managed by the SDK.
 * See `worker/durable/db/` for schema, client factory, and data access layer.
 */

import { Agent, callable } from 'agents';
import { env } from 'cloudflare:workers';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { mount, withMounts } from 'worker-fs-mount';

import { DEFAULT_AI_MODEL, getModelConfig } from '@shared/constants';
import { pendingChangesFileSchema } from '@shared/validation';

import {
	clearSessionRevertedAt,
	deleteSession,
	deletePendingChanges,
	getAllRunningSessions,
	getDatabase,
	getRunningSessionIds as getRunningSessionIdsFromDatabase,
	insertSession,
	isSessionRunning,
	listSessionIdsForPruning,
	listSessionSummaries,
	markSessionRunning,
	readPendingChangesData,
	readSession,
	removeAllRunningSessions,
	removeRunningSession,
	updateSessionForRevert,
	updateSessionHistory,
	updateSessionStatus,
	updateSessionTitle,
	upsertSessionFromService,
	writePendingChangesData,
} from './db';
import migrations from '../drizzle/migrations.js';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';
import { AIAgentService } from '../services/ai-agent';
import { chatMessagesToModelMessages, estimateMessagesTokens } from '../services/ai-agent/context-pruner';
import { accumulatePendingChange } from '../services/ai-agent/pending-changes';
import { cleanupSessionArtifacts, cleanupTimestampPlans } from '../services/ai-agent/session-cleanup';
import { generateSessionTitle } from '../services/ai-agent/title-generator';

import type { AgentDatabase, SessionRow } from './db';
import type { AgentState, AgentSessionState, SessionSummary, StreamEvent } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type {
	AgentMode,
	AgentSessionStatus,
	AiSession,
	ChatMessage,
	MessagePart,
	PendingFileChange,
	ToolErrorInfo,
	ToolMetadataInfo,
} from '@shared/types';

// =============================================================================
// Helpers
// =============================================================================

const AGENT_SESSION_STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'error', 'aborted']);
function isAgentSessionStatus(value: unknown): value is AgentSessionStatus {
	return typeof value === 'string' && AGENT_SESSION_STATUSES.has(value);
}

/**
 * Convert a Drizzle `SessionRow` into the application-level `AiSession` shape.
 *
 * Handles JSON deserialization of blob columns, null→undefined mapping,
 * and snake_case→camelCase field name conversion.
 */
function sessionRowToAiSession(row: SessionRow): AiSession {
	return {
		id: row.id,
		title: row.title,
		titleGenerated: row.titleGenerated === 1,
		createdAt: row.createdAt,
		history: JSON.parse(row.history),
		messageSnapshots: row.messageSnapshots ? JSON.parse(row.messageSnapshots) : undefined,
		messageModes: row.messageModes ? JSON.parse(row.messageModes) : undefined,
		contextTokensUsed: row.contextTokensUsed ?? undefined,
		revertedAt: row.revertedAt ?? undefined,
		toolMetadata: row.toolMetadata ? JSON.parse(row.toolMetadata) : undefined,
		toolErrors: row.toolErrors ? JSON.parse(row.toolErrors) : undefined,
		status: isAgentSessionStatus(row.status) ? row.status : undefined,
		errorMessage: row.errorMessage ?? undefined,
	};
}

// =============================================================================
// Constants
// =============================================================================

/** Project root path used by the filesystem mount. */
const PROJECT_ROOT = '/project';

/** Maximum number of sessions to retain. */
const MAX_SESSIONS = 50;

// =============================================================================
// Parameters
// =============================================================================

/**
 * Parameters for starting an agent run.
 */
export interface StartAgentParameters {
	projectId: string;
	messages: ChatMessage[];
	mode?: AgentMode;
	sessionId?: string;
	model?: AIModelId;
}

// =============================================================================
// AgentRunner
// =============================================================================

export class AgentRunner extends Agent<Env, AgentState> {
	// The instance name (agent:<projectId>) is not sensitive — explicitly opt in
	// to sending it on connect so the SDK doesn't log a warning on every connection.
	static options = { sendIdentityOnConnect: true };

	// ---- Agents SDK State ----

	initialState: AgentState = {
		currentSession: undefined,
		sessions: [],
	};

	// ---- Drizzle database instance (initialized in onStart) ----

	private db!: AgentDatabase;

	// ---- Volatile in-memory state (lost on eviction) ----

	/** Abort controllers for running sessions. */
	private abortControllers = new Map<string, AbortController>();

	/** Promises for active agent loops (for awaiting cleanup on abort). */
	private loopPromises = new Map<string, Promise<void>>();

	/** Guards against concurrent title generation. */
	private titleGenerationInFlight = new Set<string>();

	/** Buffers for accumulating partial tool call argument JSON during streaming. */
	private toolCallArgumentBuffers = new Map<string, string>();

	/** Snapshot ID for the current agent run, keyed by sessionId. */
	private currentRunSnapshotIds = new Map<string, string>();

	/**
	 * Pending content delta that hasn't been flushed to state yet, keyed by sessionId.
	 * Accumulates reasoning-delta and text-delta content between flushes.
	 * Flushed on a 50ms timer or immediately when a structural event arrives.
	 */
	private pendingContentDeltas = new Map<string, { type: 'reasoning' | 'text'; content: string }>();
	private contentFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/** Queued steering messages for running sessions, keyed by sessionId. */
	private steeringMessages = new Map<string, Array<{ id: string; content: string }>>();

	// =========================================================================
	// HTTP Request Handler
	// =========================================================================

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/pending-changes') {
			if (request.method === 'GET') {
				return Response.json(this.loadPendingChangesFromDatabase());
			}
			if (request.method === 'PUT') {
				const body: unknown = await request.json();
				const parsed = pendingChangesFileSchema.safeParse(body);
				if (!parsed.success) {
					return Response.json(
						{ error: 'Invalid pending changes' },
						{
							status: 400,
							headers: { 'Content-Type': 'application/json' },
						},
					);
				}
				if (Object.keys(parsed.data).length === 0) {
					deletePendingChanges(this.db);
				} else {
					this.savePendingChangesToDatabase(parsed.data);
				}
				return new Response(undefined, { status: 204 });
			}
		}

		return new Response('Not Found', { status: 404 });
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/**
	 * Called when the Agent starts (or wakes from hibernation / eviction).
	 * Initializes Drizzle, runs schema migrations, and restarts orphaned sessions.
	 */
	async onStart(): Promise<void> {
		// Initialize Drizzle and run migrations
		this.db = getDatabase(this.ctx.storage);
		await migrate(this.db, migrations);

		// Check for orphaned running sessions (persisted but no in-memory controller)
		const orphaned = getAllRunningSessions(this.db);

		for (const row of orphaned) {
			if (!this.abortControllers.has(row.sessionId)) {
				console.log(`[AgentRunner] onStart: restarting evicted session ${row.sessionId}`);
				try {
					const parameters: StartAgentParameters = JSON.parse(row.parameters);
					this.launchAgentLoop(parameters, row.sessionId);
				} catch (error) {
					console.error(`[AgentRunner] Failed to restart session ${row.sessionId}:`, error);
					// Remove the orphaned marker
					removeRunningSession(this.db, row.sessionId);
				}
			}
		}

		// Refresh the sessions list in state
		await this.refreshSessionsList();
	}

	// =========================================================================
	// @callable RPC Methods (invoked by clients via WebSocket)
	// =========================================================================

	/**
	 * Start an AI agent run. Returns the session ID immediately.
	 * The generation streams via the `streamRun` callable.
	 */
	@callable()
	async startRun(
		projectId: string,
		messages: ChatMessage[],
		mode: AgentMode = 'code',
		model: AIModelId = DEFAULT_AI_MODEL,
		sessionId?: string,
	): Promise<{ sessionId: string }> {
		// Rate limiting (moved from HTTP route to here, so both HTTP and Agent RPC are covered)
		if (env.AI_RATE_LIMITER) {
			const { success } = await env.AI_RATE_LIMITER.limit({ key: projectId });
			if (!success) {
				throw new Error('Rate limit exceeded. Please wait before making more AI requests.');
			}
		}

		// Model config validation
		const modelConfig = getModelConfig(model);
		if (modelConfig?.provider === 'workers-ai' && !env.AI) {
			throw new Error('Workers AI binding (AI) is not configured.');
		}

		const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

		// Already running — don't launch a duplicate
		if (isSessionRunning(this.db, resolvedSessionId)) {
			return { sessionId: resolvedSessionId };
		}

		const parameters: StartAgentParameters = {
			projectId,
			messages,
			mode,
			sessionId: resolvedSessionId,
			model,
		};

		// Persist restart parameters BEFORE launching (survives eviction)
		markSessionRunning(this.db, resolvedSessionId, JSON.stringify(parameters));

		this.launchAgentLoop(parameters, resolvedSessionId);

		// Update state immediately so clients see 'running' and the new messages.
		// Including `messages` is critical — without it, the patch branch of
		// updateSessionState only updates status/statusText, leaving the old
		// (pre-abort) messages in currentSession. The new user message would
		// not appear in the UI until streaming events start arriving.
		//
		// Set messageModes for the last user message so the mode badge renders
		// immediately (before the first turn-complete persist reloads from DB).
		const lastUserMessageIndex = parameters.messages.length - 1;
		const existingModes = this.state.currentSession?.messageModes ?? {};
		const updatedModes = {
			...existingModes,
			[String(lastUserMessageIndex)]: parameters.mode ?? 'code',
		};

		this.updateSessionState(resolvedSessionId, {
			status: 'running',
			statusText: 'Starting...',
			messages: parameters.messages,
			messageModes: updatedModes,
			error: undefined,
			pendingSteeringMessages: [],
			pendingQuestion: undefined,
			needsContinuation: false,
			doomLoopMessage: undefined,
		});

		return { sessionId: resolvedSessionId };
	}

	/**
	 * Abort a running agent session.
	 */
	@callable()
	async abortRun(sessionId?: string): Promise<void> {
		if (sessionId) {
			const controller = this.abortControllers.get(sessionId);
			if (controller) {
				controller.abort();
				this.abortControllers.delete(sessionId);
			}

			// Remove durable marker
			removeRunningSession(this.db, sessionId);

			// Wait for loop cleanup
			const loopPromise = this.loopPromises.get(sessionId);
			if (loopPromise) {
				await loopPromise.catch(() => {});
			}

			// Update state
			this.updateSessionState(sessionId, {
				status: 'aborted',
				statusText: undefined,
			});
		} else {
			// Abort all
			for (const controller of this.abortControllers.values()) {
				controller.abort();
			}
			this.abortControllers.clear();

			await Promise.allSettled(this.loopPromises.values());

			removeAllRunningSessions(this.db);

			if (this.state.currentSession) {
				this.updateSessionState(this.state.currentSession.sessionId, {
					status: 'aborted',
					statusText: undefined,
				});
			}
		}
	}

	/**
	 * Queue a steering message for a running session.
	 * The message is injected into the agent loop between iterations.
	 */
	@callable()
	async steerRun(sessionId: string, message: string): Promise<{ queued: boolean }> {
		// Only queue if the session is actually running
		const controller = this.abortControllers.get(sessionId);
		if (!controller) {
			return { queued: false };
		}

		const id = crypto.randomUUID();
		const queue = this.steeringMessages.get(sessionId) ?? [];
		queue.push({ id, content: message });
		this.steeringMessages.set(sessionId, queue);

		// Update agent state so the frontend renders the pending message immediately
		const current = this.state.currentSession;
		if (current?.sessionId === sessionId) {
			const pending = [...(current.pendingSteeringMessages ?? []), { id, content: message, createdAt: Date.now() }];
			this.updateSessionState(sessionId, { pendingSteeringMessages: pending });
		}

		return { queued: true };
	}

	/**
	 * Drain all queued steering messages for a session.
	 * Called by the agent loop between iterations.
	 */
	private drainSteeringMessages(sessionId: string): Array<{ id: string; content: string }> {
		const messages = this.steeringMessages.get(sessionId) ?? [];
		if (messages.length > 0) {
			this.steeringMessages.set(sessionId, []);
			// Clear pending display — the messages will appear as committed
			// user messages after the next persistSession + turn-complete cycle
			this.updateSessionState(sessionId, { pendingSteeringMessages: [] });
		}
		return messages;
	}

	/**
	 * Load a session into the current state.
	 */
	@callable()
	async loadSession(sessionId: string): Promise<AiSession | undefined> {
		const session = this.readSessionAsAiSession(sessionId);
		if (!session) return undefined;

		// Update agent state so all clients see the loaded session
		const pendingChangesMap = this.loadPendingChangesFromDatabase();
		const isRunning = isSessionRunning(this.db, sessionId);

		this.setState({
			...this.state,
			currentSession: {
				sessionId,
				title: session.title,
				status: isRunning ? 'running' : (session.status ?? 'idle'),
				messages: session.history,
				statusText: isRunning ? 'Thinking...' : undefined,
				error: session.errorMessage ? { message: session.errorMessage } : undefined,
				contextTokensUsed: session.contextTokensUsed ?? 0,
				pendingChanges: pendingChangesMap,
				messageSnapshots: session.messageSnapshots ?? {},
				messageModes: session.messageModes ?? {},
				toolMetadata: session.toolMetadata ?? {},
				toolErrors: session.toolErrors ?? {},
				debugLogId: undefined,
				pendingSteeringMessages: [],
				pendingQuestion: undefined,
				needsContinuation: false,
				doomLoopMessage: undefined,
			},
		});

		return session;
	}

	/**
	 * List all saved sessions (summary).
	 */
	@callable()
	async listSessions(): Promise<SessionSummary[]> {
		const runningIds = new Set(getRunningSessionIdsFromDatabase(this.db));
		const rows = listSessionSummaries(this.db);

		return rows.map((row) => ({
			id: row.id,
			title: row.title,
			createdAt: row.createdAt,
			isRunning: runningIds.has(row.id),
		}));
	}

	/**
	 * Revert a session by truncating history to a given message index.
	 */
	@callable()
	async revertSession(sessionId: string, messageIndex: number): Promise<{ contextTokensUsed: number }> {
		if (messageIndex <= 0) {
			deleteSession(this.db, sessionId);
			// Remove this session's pending changes from the global store
			// (other sessions' changes are preserved)
			this.removePendingChangesForSessions(new Set([sessionId]));
			// Clear the current session state so the frontend shows an empty chat
			if (this.state.currentSession?.sessionId === sessionId) {
				this.setState({
					...this.state,
					currentSession: undefined,
				});
			}
			await this.refreshSessionsList();
			return { contextTokensUsed: 0 };
		}

		const session = this.readSessionAsAiSession(sessionId);
		if (!session) return { contextTokensUsed: 0 };

		const truncatedHistory = session.history.slice(0, messageIndex);

		// Prune metadata above the cut point
		const prunedSnapshots = this.pruneMetadata(session.messageSnapshots, messageIndex);
		const prunedModes = this.pruneMetadata(session.messageModes, messageIndex);

		const modelMessages = chatMessagesToModelMessages(truncatedHistory);
		const contextTokensUsed = estimateMessagesTokens(modelMessages);

		updateSessionForRevert(this.db, sessionId, {
			history: JSON.stringify(truncatedHistory),
			messageSnapshots: prunedSnapshots ? JSON.stringify(prunedSnapshots) : undefined,
			messageModes: prunedModes ? JSON.stringify(prunedModes) : undefined,
			contextTokensUsed: contextTokensUsed > 0 ? contextTokensUsed : undefined,
			revertedAt: Date.now(),
		});

		// Filter pending changes: keep entries from other sessions, or from this
		// session only if their snapshotId survives the truncation.
		const survivingSnapshotIds = new Set(Object.values(prunedSnapshots ?? {}));
		const globalChanges = this.loadPendingChangesFromDatabase();
		const filteredChanges: Record<string, PendingFileChange> = {};
		for (const [path, change] of Object.entries(globalChanges)) {
			if (change.sessionId !== sessionId) {
				// Different session — always keep
				filteredChanges[path] = change;
			} else if (change.snapshotId && survivingSnapshotIds.has(change.snapshotId)) {
				// Same session but snapshot survives the truncation — keep
				filteredChanges[path] = change;
			}
			// Same session, no surviving snapshot — drop (reverted)
		}

		// Persist filtered changes to SQLite
		if (Object.keys(filteredChanges).length > 0) {
			this.savePendingChangesToDatabase(filteredChanges);
		} else {
			deletePendingChanges(this.db);
		}

		// Update state for connected clients
		if (this.state.currentSession?.sessionId === sessionId) {
			this.updateSessionState(sessionId, {
				status: 'idle',
				statusText: undefined,
				error: undefined,
				messages: truncatedHistory,
				messageSnapshots: prunedSnapshots ?? {},
				messageModes: prunedModes ?? {},
				toolMetadata: {},
				toolErrors: {},
				pendingChanges: filteredChanges,
				contextTokensUsed,
			});
		}

		await this.refreshSessionsList();
		return { contextTokensUsed };
	}

	/**
	 * Delete a session and all its associated artifacts.
	 */
	@callable()
	async deleteSession(projectId: string, sessionId: string): Promise<void> {
		deleteSession(this.db, sessionId);
		this.removePendingChangesForSessions(new Set([sessionId]));
		const survivingSnapshotIds = this.getSurvivingSnapshotIds();

		try {
			const fsId = toDurableObjectId(filesystemNamespace, projectId);
			const fsStub = filesystemNamespace.get(fsId);

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				await cleanupSessionArtifacts(PROJECT_ROOT, new Set([sessionId]), survivingSnapshotIds);
			});
		} catch (error) {
			console.error('[AgentRunner] Failed to clean up filesystem artifacts:', error);
		}

		await this.refreshSessionsList();
	}

	/**
	 * Load project-level pending changes.
	 */
	@callable()
	async loadPendingChanges(): Promise<Record<string, PendingFileChange>> {
		return this.loadPendingChangesFromDatabase();
	}

	/**
	 * Save project-level pending changes.
	 */
	@callable()
	async savePendingChanges(changes: Record<string, PendingFileChange>): Promise<void> {
		this.savePendingChangesToDatabase(changes);
	}

	/**
	 * Get the IDs of all sessions that are currently running.
	 */
	@callable()
	async getRunningSessionIds(): Promise<string[]> {
		return getRunningSessionIdsFromDatabase(this.db);
	}

	// =========================================================================
	// Agent Loop Lifecycle
	// =========================================================================

	/**
	 * Launch the agent loop asynchronously. Does not block.
	 */
	private launchAgentLoop(parameters: StartAgentParameters, sessionId: string): void {
		// Create abort controller
		this.abortControllers.set(sessionId, new AbortController());

		// Clear revertedAt flag so persist callbacks from this run are not blocked
		clearSessionRevertedAt(this.db, sessionId);

		// Early-persist the session with incoming messages
		const lastUserMessage = parameters.messages.toReversed().find((message) => message.role === 'user');
		const lastUserText =
			lastUserMessage?.parts
				.filter((part): part is { type: 'text'; content: string } => part.type === 'text')
				.map((part) => part.content)
				.join(' ')
				.trim() ?? '';
		const promptPreview = lastUserText.slice(0, 80) || 'New session';

		// Upsert the session. Use separate update/insert to preserve existing metadata
		// columns (message_snapshots, tool_metadata, etc.) that would be
		// lost with INSERT OR REPLACE (which deletes + re-inserts the row).
		const existing = readSession(this.db, sessionId);
		if (existing) {
			updateSessionHistory(this.db, sessionId, JSON.stringify(parameters.messages));
		} else {
			insertSession(this.db, {
				id: sessionId,
				title: promptPreview,
				createdAt: Date.now(),
				history: JSON.stringify(parameters.messages),
			});
		}

		// Fire title generation independently
		if (lastUserText.length > 0 && !existing?.titleGenerated) {
			void this.generateTitle(sessionId, lastUserText);
		}

		const loopPromise = this.executeAgentLoop(parameters, sessionId)
			.catch((error) => {
				console.error(`[AgentRunner ${sessionId}] Unhandled error from executeAgentLoop:`, error);
			})
			.finally(() => {
				this.loopPromises.delete(sessionId);
			});
		this.loopPromises.set(sessionId, loopPromise);
	}

	/**
	 * Execute the agent generation loop.
	 *
	 * The loop runs the AI agent service and emits stream events to connected
	 * clients via state updates. Streaming content (token-by-token text deltas,
	 * tool call args) is NOT pushed through state (too chatty). Instead, the
	 * service emits StreamEvent objects that the agent-runner broadcasts via
	 * the ProjectCoordinator WebSocket (same as before).
	 *
	 * State updates are used for:
	 * - Status changes (running → completed/error/aborted)
	 * - Finalized messages (after each turn)
	 * - Pending changes, tool metadata/errors, snapshots
	 * - Context utilization
	 */
	private async executeAgentLoop(parameters: StartAgentParameters, sessionId: string): Promise<void> {
		// Use keepAliveWhile() to prevent DO eviction during the agent loop.
		// This creates a 30s heartbeat schedule that resets the inactivity timer.
		// Replaces the manual HEARTBEAT_INTERVAL_MS + schedule() approach.
		await this.keepAliveWhile(() => this.runAgentLoopInner(parameters, sessionId));
	}

	/**
	 * Inner agent loop implementation, wrapped by keepAliveWhile() above.
	 */
	private async runAgentLoopInner(parameters: StartAgentParameters, sessionId: string): Promise<void> {
		const projectId = parameters.projectId;
		let finalStatus: AgentSessionStatus = 'completed';
		let errorMessage: string | undefined;
		let logger: import('../services/ai-agent/agent-logger').AgentLogger | undefined;
		let agentService: AIAgentService | undefined;

		try {
			const fsId = toDurableObjectId(filesystemNamespace, projectId);
			const fsStub = filesystemNamespace.get(fsId);
			const mode = parameters.mode ?? 'code';
			const model = parameters.model ?? DEFAULT_AI_MODEL;

			// Convert ChatMessage[] to ModelMessage[] for the AI SDK
			const modelMessages = chatMessagesToModelMessages(parameters.messages);

			agentService = new AIAgentService(
				PROJECT_ROOT,
				projectId,
				fsStub,
				sessionId,
				mode,
				model,
				// Persist callback — called by the service to save session state
				(sid, sessionData, pendingChangesData) => {
					this.persistSessionFromService(sid, sessionData, pendingChangesData);
					return Promise.resolve();
				},
				// Steering messages callback — drains queued user messages between iterations
				() => this.drainSteeringMessages(sessionId),
			);

			const abortController = this.abortControllers.get(sessionId) ?? new AbortController();
			const stream = agentService.runAgentStream(modelMessages, parameters.messages, abortController);

			logger = agentService.getLogger();

			for await (const event of stream) {
				if (event.type === 'run-error') {
					finalStatus = 'error';
					errorMessage = event.message || 'An unexpected error occurred during generation.';
					logger?.info('session', 'run_error_received', { errorMessage });
				}

				// Update agent state — auto-broadcast to all useAgent subscribers
				this.handleStreamEventForState(sessionId, event);
			}

			logger?.info('session', 'stream_completed', { finalStatus, errorMessage });
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				finalStatus = 'aborted';
				logger?.info('session', 'aborted');
			} else {
				finalStatus = 'error';
				const isConfigError = error instanceof Error && error.message.includes('Workers AI binding');
				errorMessage = isConfigError
					? 'AI service is not configured. Please contact the project owner.'
					: 'An unexpected error occurred during generation. Please try again.';
				console.error(`[AgentRunner ${sessionId}] Agent loop error:`, error);
				logger?.error('session', 'unhandled_error', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			// Clear run-scoped volatile state
			this.currentRunSnapshotIds.delete(sessionId);
			this.flushContentDelta(sessionId);
			this.pendingContentDeltas.delete(sessionId);

			// Remove durable running marker
			removeRunningSession(this.db, sessionId);

			// Clean up in-memory state
			this.abortControllers.delete(sessionId);
			this.steeringMessages.delete(sessionId);

			// Update state with terminal status
			this.updateSessionState(sessionId, {
				status: finalStatus,
				statusText: undefined,
				error: finalStatus === 'error' && errorMessage ? { message: errorMessage } : undefined,
				pendingSteeringMessages: [],
			});

			// Persist terminal status to DB
			updateSessionStatus(this.db, sessionId, finalStatus, errorMessage);

			// Prune old sessions
			await this.pruneOldSessions(parameters.projectId).catch((error) => {
				console.error('[AgentRunner] Session pruning failed:', error);
			});

			// Refresh sessions list
			await this.refreshSessionsList();

			// Flush logger and set debugLogId in state
			if (agentService && logger && !logger.isFlushed) {
				await agentService.flushLogger().catch(() => {});
			}
			if (logger) {
				this.updateSessionState(sessionId, { debugLogId: logger.id });
			}
		}
	}

	/**
	 * Route a stream event into the agent state for real-time UI updates.
	 *
	 * Content events (reasoning-delta, text-delta, tool-call-start, tool-call-args-delta,
	 * tool-call-end) build up the in-progress assistant message in state. On turn-complete
	 * the finalized version from the DB replaces it.
	 */
	private handleStreamEventForState(sessionId: string, event: StreamEvent): void {
		if (this.state.currentSession?.sessionId !== sessionId) return;

		switch (event.type) {
			// ── Metadata events ─────────────────────────────────────────
			case 'status': {
				this.updateSessionState(sessionId, { statusText: event.message });
				break;
			}
			case 'context-utilization': {
				this.updateSessionState(sessionId, { contextTokensUsed: event.estimatedTokens });
				break;
			}
			case 'snapshot-created': {
				this.currentRunSnapshotIds.set(sessionId, event.id);
				const current = this.state.currentSession;
				if (current) {
					const snapshots = { ...current.messageSnapshots };
					const lastUserIndex = current.messages.length - 1;
					if (lastUserIndex >= 0) {
						snapshots[String(lastUserIndex)] = event.id;
					}
					this.updateSessionState(sessionId, { messageSnapshots: snapshots });
				}
				break;
			}
			case 'file-changed': {
				if (event.action === 'create' || event.action === 'edit' || event.action === 'delete' || event.action === 'move') {
					const current = this.state.currentSession;
					if (current) {
						// Use accumulatePendingChange to preserve the original
						// beforeContent when the same file is edited multiple times.
						const changesMap = new Map(Object.entries(current.pendingChanges));
						accumulatePendingChange(changesMap, {
							path: event.path,
							action: event.action,
							beforeContent: event.beforeContent,
							afterContent: event.afterContent,
							snapshotId: this.currentRunSnapshotIds.get(sessionId),
							sessionId,
						});
						this.updateSessionState(sessionId, { pendingChanges: Object.fromEntries(changesMap) });
					}
				}
				break;
			}
			case 'tool-result': {
				// Structured metadata for rich rendering (line counts, file paths, etc.)
				const current = this.state.currentSession;
				if (!current) break;
				const toolMetadata = {
					...current.toolMetadata,
					[event.toolCallId]: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						title: event.title,
						metadata: event.metadata,
					},
				};
				this.updateSessionState(sessionId, { toolMetadata });
				break;
			}

			// ── Turn lifecycle ──────────────────────────────────────────
			case 'turn-complete': {
				this.flushContentDelta(sessionId);
				this.toolCallArgumentBuffers.clear();
				const session = this.readSessionAsAiSession(sessionId);
				if (session && this.state.currentSession?.sessionId === sessionId) {
					this.updateSessionState(sessionId, {
						messages: session.history,
						toolMetadata: session.toolMetadata ?? {},
						toolErrors: session.toolErrors ?? {},
						messageSnapshots: session.messageSnapshots ?? {},
						messageModes: session.messageModes ?? {},
					});
				}
				break;
			}

			// ── Content streaming events ────────────────────────────────
			case 'reasoning-delta': {
				this.accumulateContentDelta(sessionId, 'reasoning', event.delta);
				break;
			}
			case 'text-delta': {
				this.accumulateContentDelta(sessionId, 'text', event.delta);
				break;
			}
			case 'tool-call-start': {
				// Flush any pending content before adding a tool call part
				this.flushContentDelta(sessionId);
				const messages = this.appendToStreamingAssistantMessage(sessionId, (parts) => {
					parts.push({
						type: 'tool-call',
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						arguments: {},
					});
				});
				if (messages) this.updateSessionState(sessionId, { messages });
				break;
			}
			case 'tool-call-args-delta': {
				// Accumulate partial JSON; update arguments when it parses successfully
				const buffer = (this.toolCallArgumentBuffers.get(event.toolCallId) ?? '') + event.delta;
				this.toolCallArgumentBuffers.set(event.toolCallId, buffer);

				try {
					const parsed: unknown = JSON.parse(buffer);
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						const current = this.state.currentSession;
						if (!current) break;
						const messages = [...current.messages];
						const last = messages.at(-1);
						if (last?.role === 'assistant') {
							const parts = [...last.parts];
							const partIndex = parts.findLastIndex((p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId);
							if (partIndex !== -1 && parts[partIndex].type === 'tool-call') {
								parts[partIndex] = {
									...parts[partIndex],
									arguments: Object.fromEntries(Object.entries(parsed)),
								};
								messages[messages.length - 1] = { ...last, parts };
								this.updateSessionState(sessionId, { messages });
							}
						}
					}
				} catch {
					// Partial JSON — wait for more deltas
				}
				break;
			}
			case 'tool-call-end': {
				this.flushContentDelta(sessionId);
				this.toolCallArgumentBuffers.delete(event.toolCallId);

				const messages = this.appendToStreamingAssistantMessage(sessionId, (parts) => {
					parts.push({
						type: 'tool-result',
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result ?? '',
						isError: event.isError,
					});
				});
				if (messages) this.updateSessionState(sessionId, { messages });
				break;
			}

			// ── Follow-up prompt events ─────────────────────────────────
			case 'user-question': {
				this.updateSessionState(sessionId, {
					pendingQuestion: { question: event.question, options: event.options },
				});
				break;
			}
			case 'max-iterations-reached': {
				this.updateSessionState(sessionId, { needsContinuation: true });
				break;
			}
			case 'doom-loop-detected': {
				this.updateSessionState(sessionId, { doomLoopMessage: event.message });
				break;
			}

			// ── Events that don't update state ──────────────────────────
			default: {
				// run-error, run-finished, usage, plan-created, snapshot-deleted
				break;
			}
		}
	}

	/**
	 * Get or create the in-progress assistant message, run a mutation on its
	 * parts array, and return the updated messages array. Returns undefined
	 * if no session is active.
	 */
	private appendToStreamingAssistantMessage(sessionId: string, mutate: (parts: MessagePart[]) => void): ChatMessage[] | undefined {
		const current = this.state.currentSession;
		if (!current || current.sessionId !== sessionId) return undefined;

		const messages = [...current.messages];
		const last = messages.at(-1);

		if (last?.role === 'assistant') {
			const parts = [...last.parts];
			mutate(parts);
			messages[messages.length - 1] = { ...last, parts };
		} else {
			const parts: MessagePart[] = [];
			mutate(parts);
			messages.push({
				id: crypto.randomUUID(),
				role: 'assistant',
				parts,
				createdAt: Date.now(),
			});
		}

		return messages;
	}

	/**
	 * Flush any accumulated content delta to state immediately.
	 * Called by structural events (tool-call-start, tool-call-end, turn-complete)
	 * and on a 50ms timer for token-by-token streaming.
	 */
	private flushContentDelta(sessionId: string): void {
		const timer = this.contentFlushTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			this.contentFlushTimers.delete(sessionId);
		}

		const pending = this.pendingContentDeltas.get(sessionId);
		if (!pending) return;
		this.pendingContentDeltas.delete(sessionId);

		const messages = this.appendToStreamingAssistantMessage(sessionId, (parts) => {
			const lastPart = parts.at(-1);
			if (lastPart?.type === pending.type) {
				parts[parts.length - 1] = { ...lastPart, content: lastPart.content + pending.content };
			} else {
				if (pending.type === 'reasoning') {
					parts.push({ type: 'reasoning', content: pending.content });
				} else {
					parts.push({ type: 'text', content: pending.content });
				}
			}
		});
		if (messages) this.updateSessionState(sessionId, { messages });
	}

	/**
	 * Accumulate a content delta and schedule a flush.
	 * If the delta type changes (reasoning → text or vice versa), flush first.
	 */
	private accumulateContentDelta(sessionId: string, type: 'reasoning' | 'text', content: string): void {
		const pending = this.pendingContentDeltas.get(sessionId);

		if (pending && pending.type !== type) {
			// Type changed — flush the previous batch first
			this.flushContentDelta(sessionId);
		}

		const current = this.pendingContentDeltas.get(sessionId);
		if (current) {
			current.content += content;
		} else {
			this.pendingContentDeltas.set(sessionId, { type, content });
		}

		// Schedule flush if not already scheduled
		if (!this.contentFlushTimers.has(sessionId)) {
			this.contentFlushTimers.set(
				sessionId,
				setTimeout(() => {
					this.contentFlushTimers.delete(sessionId);
					this.flushContentDelta(sessionId);
				}, 50),
			);
		}
	}

	// =========================================================================
	// Scheduled Task: Heartbeat (secondary safety net)
	// =========================================================================

	/**
	 * Heartbeat handler called by the Agent SDK scheduler.
	 * Checks for orphaned running sessions and restarts them.
	 */
	async heartbeat(): Promise<void> {
		const orphaned = getAllRunningSessions(this.db);

		for (const row of orphaned) {
			if (!this.abortControllers.has(row.sessionId)) {
				console.log(`[AgentRunner] Heartbeat: restarting evicted session ${row.sessionId}`);
				try {
					const parameters: StartAgentParameters = JSON.parse(row.parameters);
					this.launchAgentLoop(parameters, row.sessionId);
				} catch {
					removeRunningSession(this.db, row.sessionId);
				}
			}
		}
	}

	// =========================================================================
	// Session Persistence (called by AIAgentService)
	// =========================================================================

	private persistSessionFromService(
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
		pendingChangesData?: Record<string, PendingFileChange>,
	): void {
		// Check if session was reverted while running
		const existing = readSession(this.db, sessionId);
		if (existing?.revertedAt) return;

		// Merge with existing session data
		const createdAt = existing?.createdAt ?? sessionData.createdAt;
		const title = existing?.title ?? sessionData.title ?? 'New session';
		const titleGenerated = existing?.titleGenerated === 1;
		const messageSnapshots = {
			...(existing?.messageSnapshots ? JSON.parse(existing.messageSnapshots) : undefined),
			...sessionData.messageSnapshots,
		};
		const messageModes = {
			...(existing?.messageModes ? JSON.parse(existing.messageModes) : undefined),
			...sessionData.messageModes,
		};
		const toolMetadata = {
			...(existing?.toolMetadata ? JSON.parse(existing.toolMetadata) : undefined),
			...sessionData.toolMetadata,
		};
		const toolErrors = {
			...(existing?.toolErrors ? JSON.parse(existing.toolErrors) : undefined),
			...sessionData.toolErrors,
		};

		upsertSessionFromService(this.db, {
			id: sessionId,
			title,
			titleGenerated,
			createdAt,
			history: JSON.stringify(sessionData.history),
			messageSnapshots: Object.keys(messageSnapshots).length > 0 ? JSON.stringify(messageSnapshots) : undefined,
			messageModes: Object.keys(messageModes).length > 0 ? JSON.stringify(messageModes) : undefined,
			contextTokensUsed: sessionData.contextTokensUsed,
			toolMetadata: Object.keys(toolMetadata).length > 0 ? JSON.stringify(toolMetadata) : undefined,
			toolErrors: Object.keys(toolErrors).length > 0 ? JSON.stringify(toolErrors) : undefined,
		});

		// Merge pending changes using dedup logic that preserves the original
		// beforeContent when multiple sessions edit the same file.
		if (pendingChangesData) {
			const existingChanges = this.loadPendingChangesFromDatabase();
			const mergedMap = new Map(Object.entries(existingChanges));
			for (const change of Object.values(pendingChangesData)) {
				accumulatePendingChange(mergedMap, change);
			}
			this.savePendingChangesToDatabase(Object.fromEntries(mergedMap));
		}
	}

	// =========================================================================
	// Title Generation
	// =========================================================================

	private async generateTitle(sessionId: string, userText: string): Promise<void> {
		if (this.titleGenerationInFlight.has(sessionId)) return;
		this.titleGenerationInFlight.add(sessionId);

		try {
			const result = await generateSessionTitle(userText);

			updateSessionTitle(this.db, sessionId, result.title, result.isAiGenerated);

			// Update state if this is the current session
			if (this.state.currentSession?.sessionId === sessionId) {
				this.updateSessionState(sessionId, { title: result.title });
			}

			// Refresh sessions list
			await this.refreshSessionsList();
		} catch {
			// Non-fatal
		} finally {
			this.titleGenerationInFlight.delete(sessionId);
		}
	}

	// =========================================================================
	// Session Pruning
	// =========================================================================

	private async pruneOldSessions(projectId: string): Promise<void> {
		const allSessions = listSessionIdsForPruning(this.db);

		if (allSessions.length <= MAX_SESSIONS) return;

		const runningIds = new Set(getRunningSessionIdsFromDatabase(this.db));

		const sessionsToPrune: string[] = [];
		for (const session of allSessions.slice(MAX_SESSIONS)) {
			if (!runningIds.has(session.id)) {
				sessionsToPrune.push(session.id);
			}
		}

		if (sessionsToPrune.length === 0) return;

		const prunedIds = new Set(sessionsToPrune);

		// Delete from DB
		for (const id of sessionsToPrune) {
			deleteSession(this.db, id);
		}

		this.removePendingChangesForSessions(prunedIds);
		const survivingSnapshotIds = this.getSurvivingSnapshotIds();

		// Clean up filesystem artifacts
		try {
			const fsId = toDurableObjectId(filesystemNamespace, projectId);
			const fsStub = filesystemNamespace.get(fsId);

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				await cleanupSessionArtifacts(PROJECT_ROOT, prunedIds, survivingSnapshotIds);
				await cleanupTimestampPlans(PROJECT_ROOT);
			});
		} catch (error) {
			console.error('[AgentRunner] Filesystem cleanup failed:', error);
		}
	}

	// =========================================================================
	// State Helpers
	// =========================================================================

	/**
	 * Partially update the current session state and broadcast to clients.
	 */
	private updateSessionState(sessionId: string, patch: Partial<AgentSessionState>): void {
		const current = this.state.currentSession;
		if (!current || current.sessionId !== sessionId) {
			// Create a new session state if none exists for this ID
			const session = this.readSessionAsAiSession(sessionId);
			const newState: AgentSessionState = {
				sessionId,
				title: session?.title ?? 'New session',
				status: 'idle',
				messages: session?.history ?? [],
				statusText: undefined,
				error: undefined,
				contextTokensUsed: session?.contextTokensUsed ?? 0,
				pendingChanges: this.loadPendingChangesFromDatabase(),
				messageSnapshots: session?.messageSnapshots ?? {},
				messageModes: session?.messageModes ?? {},
				toolMetadata: session?.toolMetadata ?? {},
				toolErrors: session?.toolErrors ?? {},
				debugLogId: undefined,
				pendingSteeringMessages: [],
				pendingQuestion: undefined,
				needsContinuation: false,
				doomLoopMessage: undefined,
				...patch,
			};
			this.setState({ ...this.state, currentSession: newState });
			return;
		}

		this.setState({
			...this.state,
			currentSession: { ...current, ...patch },
		});
	}

	/**
	 * Refresh the sessions summary list in state.
	 */
	private async refreshSessionsList(): Promise<void> {
		const sessionsList = await this.listSessions();
		this.setState({ ...this.state, sessions: sessionsList });
	}

	// =========================================================================
	// Database Helpers
	// =========================================================================

	/**
	 * Read a session from the database and convert to the AiSession shape.
	 */
	private readSessionAsAiSession(sessionId: string): AiSession | undefined {
		const row = readSession(this.db, sessionId);
		if (!row) return undefined;
		return sessionRowToAiSession(row);
	}

	/**
	 * Load pending changes from the database as a parsed object.
	 */
	private loadPendingChangesFromDatabase(): Record<string, PendingFileChange> {
		const data = readPendingChangesData(this.db);
		try {
			return JSON.parse(data);
		} catch {
			return {};
		}
	}

	/**
	 * Save pending changes to the database as a JSON string.
	 */
	private savePendingChangesToDatabase(changes: Record<string, PendingFileChange>): void {
		writePendingChangesData(this.db, JSON.stringify(changes));
	}

	/**
	 * Remove pending changes that belong to the specified sessions.
	 */
	private removePendingChangesForSessions(sessionIds: Set<string>): void {
		const changes = this.loadPendingChangesFromDatabase();
		let changed = false;
		for (const [path, change] of Object.entries(changes)) {
			if (sessionIds.has(change.sessionId)) {
				delete changes[path];
				changed = true;
			}
		}
		if (changed) {
			if (Object.keys(changes).length === 0) {
				deletePendingChanges(this.db);
			} else {
				this.savePendingChangesToDatabase(changes);
			}
		}
	}

	/**
	 * Get snapshot IDs that are still referenced by surviving pending changes.
	 */
	private getSurvivingSnapshotIds(): Set<string> {
		const surviving = new Set<string>();
		const changes = this.loadPendingChangesFromDatabase();
		for (const change of Object.values(changes)) {
			if (change.snapshotId) {
				surviving.add(change.snapshotId);
			}
		}
		return surviving;
	}

	private pruneMetadata<T>(metadata: Record<string, T> | undefined, messageIndex: number): Record<string, T> | undefined {
		if (!metadata) return undefined;
		const pruned: Record<string, T> = {};
		for (const [key, value] of Object.entries(metadata)) {
			if (Number(key) < messageIndex) {
				pruned[key] = value;
			}
		}
		return Object.keys(pruned).length > 0 ? pruned : undefined;
	}
}
