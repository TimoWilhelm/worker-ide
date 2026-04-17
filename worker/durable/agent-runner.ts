import { ExtensionManager } from '@cloudflare/think/extensions';
import { Agent, callable } from 'agents';
import { SessionManager } from 'agents/experimental/memory/session';
import { env } from 'cloudflare:workers';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { mount, withMounts } from 'worker-fs-mount';

import { AGENT_SYSTEM_PROMPT, DEFAULT_AI_MODEL, MAX_AI_SESSIONS_PER_PROJECT, getModelConfig } from '@shared/constants';
import { pendingChangesFileSchema, sessionTitleSchema } from '@shared/validation';

import {
	buildLoadedExtensionsSummary,
	buildRecoveredRunParameters,
	parseFiberSnapshot,
	restoreExtensionManager,
	runSessionSearch,
} from './agent-runner-helpers';
import {
	deleteSessionMetadata,
	deletePendingChanges,
	getDatabase,
	readPendingChangesData,
	readSessionMetadata,
	updateSessionMetadataStatus,
	updateSessionMetadataTitleGenerated,
	upsertSessionMetadata,
	writePendingChangesData,
} from './db';
import { trackAiUsage, trackWebSocketEvent } from '../lib/analytics';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';
import migrations from '../migrations/do-agent/migrations.js';
import { AIAgentService } from '../services/ai-agent';
import { chatMessagesToModelMessages, estimateMessagesTokens } from '../services/ai-agent/context-pruner';
import { accumulatePendingChange } from '../services/ai-agent/pending-changes';
import { cleanupSessionArtifacts, cleanupTimestampPlans } from '../services/ai-agent/session-cleanup';
import { chatMessageToSessionMessage, sessionMessagesToChatMessages } from '../services/ai-agent/session-messages';
import { readAgentsContext } from '../services/ai-agent/system-prompt-builder';
import { generateSessionTitle } from '../services/ai-agent/title-generator';

import type { AgentDatabase } from './db';
import type { AgentState, AgentSessionState, FiberSnapshot, SessionSummary, StreamEvent } from '@shared/agent-state';
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
import type { SessionInfo } from 'agents/experimental/memory/session';

const AGENT_SESSION_STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'error', 'aborted']);
function isAgentSessionStatus(value: unknown): value is AgentSessionStatus {
	return typeof value === 'string' && AGENT_SESSION_STATUSES.has(value);
}

function buildAiSession(sessionInfo: SessionInfo, history: ChatMessage[], metadata: ReturnType<typeof parseSessionMetadata>): AiSession {
	return {
		id: sessionInfo.id,
		title: sessionInfo.name,
		titleGenerated: metadata.titleGenerated,
		createdAt: Date.parse(sessionInfo.created_at),
		history,
		messageSnapshots: metadata.messageSnapshots,
		messageModes: metadata.messageModes,
		contextTokensUsed: metadata.contextTokensUsed,
		toolMetadata: metadata.toolMetadata,
		toolErrors: metadata.toolErrors,
		status: metadata.status,
		errorMessage: metadata.errorMessage,
	};
}

function parseSessionMetadata(row: ReturnType<typeof readSessionMetadata>): {
	titleGenerated?: boolean;
	messageSnapshots?: Record<string, string>;
	messageModes?: Record<string, AgentMode>;
	contextTokensUsed?: number;
	toolMetadata?: Record<string, ToolMetadataInfo>;
	toolErrors?: Record<string, ToolErrorInfo>;
	status?: AgentSessionStatus;
	errorMessage?: string;
} {
	if (!row) {
		return {};
	}

	return {
		titleGenerated: row.titleGenerated === 1,
		messageSnapshots: row.messageSnapshots ? JSON.parse(row.messageSnapshots) : undefined,
		messageModes: row.messageModes ? JSON.parse(row.messageModes) : undefined,
		contextTokensUsed: row.contextTokensUsed ?? undefined,
		toolMetadata: row.toolMetadata ? JSON.parse(row.toolMetadata) : undefined,
		toolErrors: row.toolErrors ? JSON.parse(row.toolErrors) : undefined,
		status: isAgentSessionStatus(row.status) ? row.status : undefined,
		errorMessage: row.errorMessage ?? undefined,
	};
}
const PROJECT_ROOT = '/project';
const MAX_SESSIONS = MAX_AI_SESSIONS_PER_PROJECT;
export interface StartAgentParameters {
	projectId: string;
	messages: ChatMessage[];
	mode?: AgentMode;
	sessionId?: string;
	model?: AIModelId;
	initiatorUserId?: string;
	_fiberSnapshot?: FiberSnapshot;
}

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
	private extensionManager?: ExtensionManager;
	private sessionManager = SessionManager.create(this)
		.withContext('soul', {
			provider: {
				get: async () => this.getSoulPrompt(),
			},
		})
		.withContext('memory', {
			description: 'Important facts about this project learned across sessions.',
			maxTokens: 2000,
		})
		.withCachedPrompt()
		.withSearchableHistory('history');

	// ---- Volatile in-memory state (lost on eviction) ----
	private abortControllers = new Map<string, AbortController>();
	private loopPromises = new Map<string, Promise<void>>();
	private titleGenerationInFlight = new Set<string>();
	private toolCallArgumentBuffers = new Map<string, Map<string, string>>();
	private currentRunSnapshotIds = new Map<string, string>();

	/**
	 * Pending content delta that hasn't been flushed to state yet, keyed by sessionId.
	 * Accumulates reasoning-delta and text-delta content between flushes.
	 * Flushed on a 50ms timer or immediately when a structural event arrives.
	 */
	private pendingContentDeltas = new Map<string, { type: 'reasoning' | 'text'; content: string }>();
	private contentFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Pending sub-agent streaming text deltas, keyed by sessionId → parentToolCallId.
	 * Batched on a 50ms timer to avoid per-token setState broadcasts.
	 */
	private pendingSubAgentDeltas = new Map<string, Map<string, string>>();
	private subAgentDeltaFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private steeringMessages = new Map<string, Array<{ id: string; content: string }>>();
	private sessionInitiatorUserIds = new Map<string, string>();
	private connectionUserIds = new Map<string, string>();
	private sessionAnalytics = new Map<
		string,
		{ inputTokens: number; outputTokens: number; durationMs: number; toolCallCount: number; turnNumber: number }
	>();

	// =========================================================================
	// State Validation
	// =========================================================================

	/**
	 * Validate structural invariants before state is persisted and broadcast.
	 * Runs synchronously — throwing rejects the update.
	 */
	validateStateChange(nextState: AgentState): void {
		if (nextState.currentSession !== undefined) {
			const session = nextState.currentSession;
			if (!session.sessionId) {
				throw new Error('AgentSessionState requires a non-empty sessionId');
			}
			if (!Array.isArray(session.messages)) {
				throw new TypeError('AgentSessionState.messages must be an array');
			}
			if (typeof session.contextTokensUsed !== 'number' || session.contextTokensUsed < 0) {
				throw new Error('AgentSessionState.contextTokensUsed must be a non-negative number');
			}
		}
		if (!Array.isArray(nextState.sessions)) {
			throw new TypeError('AgentState.sessions must be an array');
		}
	}

	// =========================================================================
	// WebSocket Lifecycle
	// =========================================================================

	/**
	 * Called by the Agents SDK when a new WebSocket connection is established.
	 * Extracts the authenticated userId forwarded by the main Worker and stores
	 * it keyed by connection ID for later use in @callable methods.
	 */
	async onConnect(connection: import('agents').Connection<unknown>, context: import('agents').ConnectionContext): Promise<void> {
		await super.onConnect(connection, context);
		const userId = context.request?.headers.get('x-worker-ide-user-id');
		if (userId) {
			this.connectionUserIds.set(connection.id, userId);
		}

		trackWebSocketEvent({
			projectId: this.ctx.id.toString(),
			eventType: 'connect',
			connectionType: 'agent',
			userId: userId ?? undefined,
			concurrentConnections: this.connectionUserIds.size,
		});
	}

	onClose(connection: import('agents').Connection<unknown>): void {
		this.connectionUserIds.delete(connection.id);

		trackWebSocketEvent({
			projectId: this.ctx.id.toString(),
			eventType: 'disconnect',
			connectionType: 'agent',
			concurrentConnections: this.connectionUserIds.size,
		});
	}

	/**
	 * Get the authenticated user ID for the current caller.
	 * Falls back to scanning all connections when exact match is not found.
	 */
	private getAuthenticatedUserId(): string | undefined {
		// If there's only one connection, return its userId (most common case)
		if (this.connectionUserIds.size === 1) {
			return [...this.connectionUserIds.values()][0];
		}
		// Return the first userId found (all connections are pre-authed by the main Worker)
		for (const userId of this.connectionUserIds.values()) {
			return userId;
		}
		return undefined;
	}

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
	 * Initializes Drizzle, runs schema migrations, and restores extensions.
	 */
	async onStart(): Promise<void> {
		this.db = getDatabase(this.ctx.storage);
		await migrate(this.db, migrations);
		this.extensionManager = await restoreExtensionManager(env.LOADER, this.ctx.storage);
		await this.refreshSessionsList();
	}

	private async getSoulPrompt(): Promise<string> {
		const agentsContext = await readAgentsContext(PROJECT_ROOT);
		if (!agentsContext) {
			return AGENT_SYSTEM_PROMPT;
		}

		return `${AGENT_SYSTEM_PROMPT}\n\n## Project Guidelines (from AGENTS.md)\n${agentsContext}`;
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
		// Rate limiting keyed on projectId — the DO is 1:1 with a project.
		// Never use client-supplied context for rate-limit keys.
		if (env.AI_RATE_LIMITER) {
			const { success } = await env.AI_RATE_LIMITER.limit({ key: projectId });
			if (!success) {
				throw new Error('Rate limit exceeded. Please wait before making more AI requests.');
			}
		}

		// Best-effort user attribution from trusted server-forwarded header
		const authenticatedUserId = this.getAuthenticatedUserId();

		// Model config validation
		const modelConfig = getModelConfig(model);
		if (modelConfig?.provider === 'workers-ai' && !env.AI) {
			throw new Error('Workers AI binding (AI) is not configured.');
		}

		const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

		if (this.abortControllers.has(resolvedSessionId)) {
			return { sessionId: resolvedSessionId };
		}

		const parameters: StartAgentParameters = {
			projectId,
			messages,
			mode,
			sessionId: resolvedSessionId,
			model,
			initiatorUserId: authenticatedUserId,
		};

		await this.launchAgentLoop(parameters, resolvedSessionId);

		this.sessionAnalytics.set(resolvedSessionId, {
			inputTokens: 0,
			outputTokens: 0,
			durationMs: Date.now(),
			toolCallCount: 0,
			turnNumber: 0,
		});

		trackAiUsage({
			userId: authenticatedUserId ?? '',
			eventType: 'session_start',
			projectId,
			modelId: model,
			sessionId: resolvedSessionId,
			agentMode: mode,
			inputTokens: 0,
			outputTokens: 0,
			durationMs: 0,
			toolCallCount: 0,
			turnNumber: 0,
		});

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
			subAgentActivities: {},
		});

		return { sessionId: resolvedSessionId };
	}
	@callable()
	async abortRun(sessionId?: string): Promise<void> {
		if (sessionId) {
			const controller = this.abortControllers.get(sessionId);
			if (controller) {
				controller.abort();
				this.abortControllers.delete(sessionId);
			}

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
	 *
	 * Note: The returned `AiSession` is always read from the database, so during
	 * an active streaming turn it will be **stale** (missing in-flight messages).
	 * Callers must not rely on the return value for up-to-date message history;
	 * instead, they should consume `agent.state.currentSession` which is kept
	 * current via real-time state sync.
	 */
	@callable()
	async loadSession(sessionId: string): Promise<AiSession | undefined> {
		const session = this.readSessionAsAiSession(sessionId);
		if (!session) return undefined;

		// If this session is already loaded and actively running, don't overwrite
		// the live in-memory state with stale DB data. Mid-turn streaming content
		// (thinking, partial tool calls, in-progress text) only exists in
		// this.state.currentSession.messages and hasn't been persisted to the DB
		// yet (only persisted on turn-complete). Overwriting would lose messages.
		if (this.state.currentSession?.sessionId === sessionId && this.abortControllers.has(sessionId)) {
			return session;
		}

		// Update agent state so all clients see the loaded session
		const pendingChangesMap = this.loadPendingChangesFromDatabase();
		const isRunning = this.abortControllers.has(sessionId);

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
				subAgentActivities: {},
				contextBlocksSummary: this.getContextBlocksSummary(sessionId),
				extensions: this.getLoadedExtensionsSummary(),
			},
		});

		return session;
	}
	@callable()
	async listSessions(): Promise<SessionSummary[]> {
		return this.sessionManager
			.list()
			.toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
			.map((sessionInfo) => ({
				id: sessionInfo.id,
				title: sessionInfo.name,
				createdAt: Date.parse(sessionInfo.created_at),
				isRunning: this.abortControllers.has(sessionInfo.id),
			}));
	}

	@callable()
	async searchSessions(query: string, limit = 20): Promise<Array<{ sessionId: string; role: string; content: string }>> {
		return runSessionSearch(
			query,
			limit,
			(trimmedQuery, resolvedLimit) =>
				this.sql<{ sessionId: string; role: string; content: string }>`
				SELECT session_id as sessionId, role, content
				FROM assistant_fts
				WHERE assistant_fts MATCH ${trimmedQuery}
				LIMIT ${resolvedLimit}
			`,
		);
	}
	@callable()
	async revertSession(sessionId: string, messageIndex: number): Promise<{ contextTokensUsed: number }> {
		if (messageIndex <= 0) {
			this.sessionManager.delete(sessionId);
			deleteSessionMetadata(this.db, sessionId);
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

		const sourceSession = this.sessionManager.get(sessionId);
		if (!sourceSession) return { contextTokensUsed: 0 };
		const sourceHistory = this.sessionManager.getHistory(sessionId);
		const targetMessage = sourceHistory[messageIndex];
		if (!targetMessage) return { contextTokensUsed: 0 };

		const forkedSession = await this.sessionManager.fork(sessionId, targetMessage.id, `${sourceSession.name} (fork)`);
		const truncatedHistory = sessionMessagesToChatMessages(this.sessionManager.getHistory(forkedSession.id));
		const sourceMetadata = parseSessionMetadata(readSessionMetadata(this.db, sessionId));
		const prunedSnapshots = this.pruneMetadata(sourceMetadata.messageSnapshots, messageIndex);
		const prunedModes = this.pruneMetadata(sourceMetadata.messageModes, messageIndex);
		const modelMessages = chatMessagesToModelMessages(truncatedHistory);
		const contextTokensUsed = estimateMessagesTokens(modelMessages);
		upsertSessionMetadata(this.db, {
			id: forkedSession.id,
			titleGenerated: sourceMetadata.titleGenerated ? 1 : 0,
			messageSnapshots: prunedSnapshots ? JSON.stringify(prunedSnapshots) : undefined,
			messageModes: prunedModes ? JSON.stringify(prunedModes) : undefined,
			contextTokensUsed: contextTokensUsed > 0 ? contextTokensUsed : undefined,
			toolMetadata: undefined,
			toolErrors: undefined,
			status: 'idle',
			errorMessage: undefined,
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
				filteredChanges[path] = { ...change, sessionId: forkedSession.id };
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
			this.updateSessionState(forkedSession.id, {
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
	@callable()
	async renameSession(sessionId: string, title: string): Promise<void> {
		const parsed = sessionTitleSchema.safeParse(title);
		if (!parsed.success) {
			throw new Error(parsed.error.issues[0]?.message ?? 'Invalid title');
		}
		this.sessionManager.rename(sessionId, parsed.data);
		updateSessionMetadataTitleGenerated(this.db, sessionId, false);

		// Update current session state so all clients see the new title immediately
		if (this.state.currentSession?.sessionId === sessionId) {
			this.updateSessionState(sessionId, { title: parsed.data });
		}

		await this.refreshSessionsList();
	}

	/**
	 * Delete a session and all its associated artifacts.
	 * If the session is running, it is aborted first.
	 */
	@callable()
	async deleteSession(projectId: string, sessionId: string): Promise<void> {
		// Abort if the session is currently running
		const controller = this.abortControllers.get(sessionId);
		if (controller) {
			controller.abort();
			this.abortControllers.delete(sessionId);
		}
		// Wait for loop cleanup
		const loopPromise = this.loopPromises.get(sessionId);
		if (loopPromise) {
			await loopPromise.catch(() => {});
		}

		// Clean up all volatile in-memory state for this session
		this.flushContentDelta(sessionId);
		this.pendingContentDeltas.delete(sessionId);
		this.flushSubAgentDeltas(sessionId);
		this.currentRunSnapshotIds.delete(sessionId);
		this.steeringMessages.delete(sessionId);
		this.sessionInitiatorUserIds.delete(sessionId);
		this.sessionAnalytics.delete(sessionId);
		this.titleGenerationInFlight.delete(sessionId);

		this.sessionManager.delete(sessionId);
		deleteSessionMetadata(this.db, sessionId);
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

		// Clear current session for all clients if this was the active session
		if (this.state.currentSession?.sessionId === sessionId) {
			this.setState({ ...this.state, currentSession: undefined });
		}

		await this.refreshSessionsList();
	}
	@callable()
	async loadPendingChanges(): Promise<Record<string, PendingFileChange>> {
		return this.loadPendingChangesFromDatabase();
	}
	@callable()
	async savePendingChanges(changes: Record<string, PendingFileChange>): Promise<void> {
		this.savePendingChangesToDatabase(changes);
	}

	/**
	 * Clear the current session state (start fresh).
	 * Aborts any running session first.
	 */
	@callable()
	async clearCurrentSession(sessionId?: string): Promise<void> {
		if (sessionId) {
			const controller = this.abortControllers.get(sessionId);
			if (controller) {
				controller.abort();
				this.abortControllers.delete(sessionId);
			}
			const loopPromise = this.loopPromises.get(sessionId);
			if (loopPromise) {
				await loopPromise.catch(() => {});
			}
		}
		this.setState({ ...this.state, currentSession: undefined });
	}
	@callable()
	async getRunningSessionIds(): Promise<string[]> {
		return [...this.abortControllers.keys()];
	}

	// =========================================================================
	// Agent Loop Lifecycle
	// =========================================================================
	private async launchAgentLoop(parameters: StartAgentParameters, sessionId: string): Promise<void> {
		// Create abort controller
		this.abortControllers.set(sessionId, new AbortController());

		// Track initiator userId for targeted push notifications (survives eviction via parameters)
		if (parameters.initiatorUserId) {
			this.sessionInitiatorUserIds.set(sessionId, parameters.initiatorUserId);
		}

		const lastUserMessage = parameters.messages.toReversed().find((message) => message.role === 'user');
		const lastUserText =
			lastUserMessage?.parts
				.filter((part): part is { type: 'text'; content: string } => part.type === 'text')
				.map((part) => part.content)
				.join(' ')
				.trim() ?? '';
		const promptPreview = lastUserText.slice(0, 80) || 'New session';

		const existing = this.sessionManager.get(sessionId);
		if (!existing) {
			this.ensureSessionRecord(sessionId, promptPreview, parameters.model, parameters.mode);
		}
		this.sessionManager.clearMessages(sessionId);
		await this.sessionManager.appendAll(
			sessionId,
			parameters.messages.map((message) => chatMessageToSessionMessage(message)),
		);

		// Fire title generation independently
		if (lastUserText.length > 0 && !parseSessionMetadata(readSessionMetadata(this.db, sessionId)).titleGenerated) {
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
		await this.runFiber(`agent-loop:${sessionId}`, async () => this.runAgentLoopInner(parameters, sessionId));
	}

	async onFiberRecovered(context: import('agents').FiberRecoveryContext): Promise<void> {
		if (!context.name.startsWith('agent-loop:')) {
			return;
		}
		const sessionId = context.name.slice('agent-loop:'.length);
		const snapshot = parseFiberSnapshot(context.snapshot);
		const session = this.readSessionAsAiSession(sessionId);
		const parameters = session ? buildRecoveredRunParameters(this.getProjectId(), sessionId, session.history, snapshot) : undefined;
		if (!parameters) {
			return;
		}

		await this.launchAgentLoop(parameters, sessionId);
	}
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
			const session = this.sessionManager.getSession(sessionId);

			// Convert ChatMessage[] to ModelMessage[] for the AI SDK
			const modelMessages = chatMessagesToModelMessages(parameters.messages);

			agentService = new AIAgentService(
				PROJECT_ROOT,
				projectId,
				fsStub,
				sessionId,
				mode,
				model,
				(sid, sessionData) => this.persistSessionFromService(sid, sessionData),
				// Steering messages callback — drains queued user messages between iterations
				() => this.drainSteeringMessages(sessionId),
				false,
				session,
				this.extensionManager,
				env.LOADER,
				env.BROWSER,
				this,
				parameters._fiberSnapshot,
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
			this.flushSubAgentDeltas(sessionId);

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

			updateSessionMetadataStatus(this.db, sessionId, finalStatus, errorMessage);

			const analytics = this.sessionAnalytics.get(sessionId);
			const sessionDurationMs = analytics ? Date.now() - analytics.durationMs : 0;

			trackAiUsage({
				userId: this.sessionInitiatorUserIds.get(sessionId) ?? '',
				eventType: 'session_end',
				projectId,
				modelId: parameters.model ?? DEFAULT_AI_MODEL,
				sessionId,
				agentMode: parameters.mode ?? 'code',
				error: errorMessage,
				inputTokens: analytics?.inputTokens ?? 0,
				outputTokens: analytics?.outputTokens ?? 0,
				durationMs: sessionDurationMs,
				toolCallCount: analytics?.toolCallCount ?? 0,
				turnNumber: analytics?.turnNumber ?? 0,
			});

			this.sessionAnalytics.delete(sessionId);

			// Send push notification on completion/error (not on abort — user triggered it)
			const initiatorUserId = this.sessionInitiatorUserIds.get(sessionId);
			if (initiatorUserId) {
				if (finalStatus === 'completed') {
					this.sendPushNotification(initiatorUserId, sessionId, 'Generation complete', 'Your AI agent has finished.');
				} else if (finalStatus === 'error') {
					this.sendPushNotification(initiatorUserId, sessionId, 'Generation failed', errorMessage ?? 'An error occurred.');
				}
			}

			// Clean up initiator tracking
			this.sessionInitiatorUserIds.delete(sessionId);

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
			case 'snapshot-deleted': {
				this.currentRunSnapshotIds.delete(sessionId);
				const current = this.state.currentSession;
				if (!current) break;

				const snapshots = { ...current.messageSnapshots };
				let changed = false;
				for (const [key, snapshotId] of Object.entries(snapshots)) {
					if (snapshotId === event.id) {
						delete snapshots[key];
						changed = true;
					}
				}

				if (changed) {
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
				this.toolCallArgumentBuffers.delete(sessionId);
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
				// Increment turn counter for analytics
				const turnAnalytics = this.sessionAnalytics.get(sessionId);
				if (turnAnalytics) {
					turnAnalytics.turnNumber += 1;
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
				// Increment tool call counter for analytics
				const toolAnalytics = this.sessionAnalytics.get(sessionId);
				if (toolAnalytics) {
					toolAnalytics.toolCallCount += 1;
				}
				break;
			}
			case 'tool-call-args-delta': {
				// Accumulate partial JSON; update arguments when it parses successfully
				let sessionBuffers = this.toolCallArgumentBuffers.get(sessionId);
				if (!sessionBuffers) {
					sessionBuffers = new Map();
					this.toolCallArgumentBuffers.set(sessionId, sessionBuffers);
				}
				const buffer = (sessionBuffers.get(event.toolCallId) ?? '') + event.delta;
				sessionBuffers.set(event.toolCallId, buffer);

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
				this.toolCallArgumentBuffers.get(sessionId)?.delete(event.toolCallId);

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
				// Send push notification so the user knows the agent needs input
				const questionInitiatorUserId = this.sessionInitiatorUserIds.get(sessionId);
				if (questionInitiatorUserId) {
					this.sendPushNotification(questionInitiatorUserId, sessionId, 'Agent needs your input', event.question);
				}
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

			// ── Sub-agent activity events ────────────────────────────────
			case 'sub-agent-activity': {
				if (!this.state.currentSession) break;
				const parentId = event.parentToolCallId;

				// Text deltas are batched on a 50ms timer (same pattern as main content deltas)
				if (event.activity.kind === 'text-delta') {
					this.accumulateSubAgentDelta(sessionId, parentId, event.activity.delta);
					break;
				}

				// tool-start and non-error tool-end don't change state — skip the broadcast
				if (event.activity.kind === 'tool-start' || (event.activity.kind === 'tool-end' && !event.activity.isError)) {
					break;
				}

				// Structural event — flush any pending text deltas first
				this.flushSubAgentDeltas(sessionId);

				// Re-read state after flush (flush may have called updateSessionState)
				const current = this.state.currentSession;
				if (!current) break;

				const activities = { ...current.subAgentActivities };
				const existing = activities[parentId] ?? { tools: [], debugLogId: undefined, streamingText: undefined };

				switch (event.activity.kind) {
					case 'debug-log': {
						// Persist the sub-agent's debug log ID for UI download
						activities[parentId] = {
							...existing,
							debugLogId: event.activity.debugLogId,
						};
						break;
					}
					case 'tool-metadata': {
						// Append a completed tool entry with metadata
						activities[parentId] = {
							...existing,
							tools: [
								...existing.tools,
								{
									toolName: event.activity.toolName,
									title: event.activity.title,
									metadata: event.activity.metadata,
								},
							],
						};
						break;
					}
					case 'tool-end': {
						// Only error tool-end reaches here (non-error filtered above)
						activities[parentId] = {
							...existing,
							tools: [
								...existing.tools,
								{
									toolName: event.activity.toolName,
									title: 'Error',
									metadata: {},
									isError: true,
								},
							],
						};
						break;
					}
					default: {
						break;
					}
				}

				this.updateSessionState(sessionId, { subAgentActivities: activities });
				break;
			}

			// ── Token usage event ────────────────────────────────────────
			case 'usage': {
				// Capture cumulative token totals for session_end analytics
				const usageAnalytics = this.sessionAnalytics.get(sessionId);
				if (usageAnalytics) {
					usageAnalytics.inputTokens = event.input;
					usageAnalytics.outputTokens = event.output;
				}
				break;
			}

			// ── Events that don't update state ──────────────────────────
			default: {
				// run-error, run-finished, plan-created, snapshot-deleted
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

	/**
	 * Flush any accumulated sub-agent text deltas to state immediately.
	 * Called by structural sub-agent events (tool-metadata, tool-end, debug-log)
	 * and on a 50ms timer for token-by-token streaming.
	 */
	private flushSubAgentDeltas(sessionId: string): void {
		const timer = this.subAgentDeltaFlushTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			this.subAgentDeltaFlushTimers.delete(sessionId);
		}

		const sessionDeltas = this.pendingSubAgentDeltas.get(sessionId);
		if (!sessionDeltas || sessionDeltas.size === 0) return;

		const current = this.state.currentSession;
		if (!current || current.sessionId !== sessionId) {
			this.pendingSubAgentDeltas.delete(sessionId);
			return;
		}

		const activities = { ...current.subAgentActivities };
		for (const [parentId, delta] of sessionDeltas) {
			const existing = activities[parentId] ?? { tools: [], debugLogId: undefined, streamingText: undefined };
			activities[parentId] = {
				...existing,
				streamingText: (existing.streamingText ?? '') + delta,
			};
		}
		this.pendingSubAgentDeltas.delete(sessionId);
		this.updateSessionState(sessionId, { subAgentActivities: activities });
	}
	private accumulateSubAgentDelta(sessionId: string, parentToolCallId: string, delta: string): void {
		let sessionDeltas = this.pendingSubAgentDeltas.get(sessionId);
		if (!sessionDeltas) {
			sessionDeltas = new Map();
			this.pendingSubAgentDeltas.set(sessionId, sessionDeltas);
		}
		const current = sessionDeltas.get(parentToolCallId);
		sessionDeltas.set(parentToolCallId, (current ?? '') + delta);

		if (!this.subAgentDeltaFlushTimers.has(sessionId)) {
			this.subAgentDeltaFlushTimers.set(
				sessionId,
				setTimeout(() => {
					this.subAgentDeltaFlushTimers.delete(sessionId);
					this.flushSubAgentDeltas(sessionId);
				}, 50),
			);
		}
	}

	// =========================================================================
	// Session Persistence (called by AIAgentService)
	// =========================================================================

	private async persistSessionFromService(
		sessionId: string,
		sessionData: import('../services/ai-agent/types').SessionPersistData,
	): Promise<void> {
		const existing = parseSessionMetadata(readSessionMetadata(this.db, sessionId));
		const messageSnapshots = { ...existing.messageSnapshots, ...sessionData.messageSnapshots };
		const messageModes = { ...existing.messageModes, ...sessionData.messageModes };
		const toolMetadata = { ...existing.toolMetadata, ...sessionData.toolMetadata };
		const toolErrors = { ...existing.toolErrors, ...sessionData.toolErrors };

		this.sessionManager.clearMessages(sessionId);
		await this.sessionManager.appendAll(
			sessionId,
			sessionData.history.map((message) => chatMessageToSessionMessage(message)),
		);

		upsertSessionMetadata(this.db, {
			id: sessionId,
			titleGenerated: existing.titleGenerated ? 1 : 0,
			messageSnapshots: Object.keys(messageSnapshots).length > 0 ? JSON.stringify(messageSnapshots) : undefined,
			messageModes: Object.keys(messageModes).length > 0 ? JSON.stringify(messageModes) : undefined,
			contextTokensUsed: sessionData.contextTokensUsed,
			toolMetadata: Object.keys(toolMetadata).length > 0 ? JSON.stringify(toolMetadata) : undefined,
			toolErrors: Object.keys(toolErrors).length > 0 ? JSON.stringify(toolErrors) : undefined,
			status: sessionData.error ? 'error' : existing.status,
			errorMessage: sessionData.error?.message ?? existing.errorMessage,
		});

		// Merge pending changes using dedup logic that preserves the original
		// beforeContent when multiple sessions edit the same file.
		if (sessionData.pendingChanges) {
			const existingChanges = this.loadPendingChangesFromDatabase();
			const mergedMap = new Map(Object.entries(existingChanges));
			for (const change of Object.values(sessionData.pendingChanges)) {
				accumulatePendingChange(mergedMap, change);
			}
			this.savePendingChangesToDatabase(Object.fromEntries(mergedMap));
		}

		if (sessionData.fiberSnapshot) {
			this.stash(sessionData.fiberSnapshot);
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

			this.sessionManager.rename(sessionId, result.title);
			updateSessionMetadataTitleGenerated(this.db, sessionId, result.isAiGenerated);

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
		const allSessions = this.sessionManager
			.list()
			.toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
			.map((sessionInfo) => ({ id: sessionInfo.id, createdAt: Date.parse(sessionInfo.created_at) }));

		if (allSessions.length <= MAX_SESSIONS) return;

		const runningIds = new Set(this.abortControllers.keys());

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
			this.sessionManager.delete(id);
			deleteSessionMetadata(this.db, id);
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
				subAgentActivities: {},
				contextBlocksSummary: this.getContextBlocksSummary(sessionId),
				extensions: this.getLoadedExtensionsSummary(),
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
	private async refreshSessionsList(): Promise<void> {
		const sessionsList = await this.listSessions();
		this.setState({ ...this.state, sessions: sessionsList });
	}

	// =========================================================================
	// Database Helpers
	// =========================================================================
	private readSessionAsAiSession(sessionId: string): AiSession | undefined {
		const sessionInfo = this.sessionManager.get(sessionId);
		if (!sessionInfo) return undefined;
		const history = sessionMessagesToChatMessages(this.sessionManager.getHistory(sessionId));
		const metadata = parseSessionMetadata(readSessionMetadata(this.db, sessionId));
		return buildAiSession(sessionInfo, history, metadata);
	}
	private loadPendingChangesFromDatabase(): Record<string, PendingFileChange> {
		const data = readPendingChangesData(this.db);
		try {
			return JSON.parse(data);
		} catch {
			return {};
		}
	}
	private savePendingChangesToDatabase(changes: Record<string, PendingFileChange>): void {
		writePendingChangesData(this.db, JSON.stringify(changes));
	}
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

	/**
	 * Send a push notification to the session initiator.
	 * Uses the explicitly provided userId (persisted in StartAgentParameters)
	 * rather than scanning live WebSocket connections, so notifications
	 * work correctly after DO eviction and in multi-user projects.
	 */
	private sendPushNotification(userId: string, sessionId: string, title: string, body: string): void {
		const projectId = this.getProjectId();
		if (!projectId) return;

		try {
			env.PUSH.notifyUser(userId, {
				tag: sessionId,
				title,
				body,
				path: `/p/${projectId}`,
			}).catch((error: unknown) => {
				console.error('[AgentRunner] Failed to send push notification:', error);
			});
		} catch {
			// Push service binding may not be available in dev
		}
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

	private ensureSessionRecord(sessionId: string, title: string, model?: AIModelId, source?: AgentMode): void {
		/* eslint-disable unicorn/no-null -- SQL NULL values are required for optional session fields */
		this.sql`
			INSERT OR IGNORE INTO assistant_sessions (id, name, parent_session_id, model, source)
			VALUES (${sessionId}, ${title}, NULL, ${model ?? null}, ${source ?? null})
		`;
		/* eslint-enable unicorn/no-null */
	}

	private getContextBlocksSummary(sessionId: string): Record<string, { description?: string; available?: boolean }> {
		return Object.fromEntries(
			this.sessionManager
				.getSession(sessionId)
				.getContextBlocks()
				.map((block) => [block.label, { description: block.description, available: true }]),
		);
	}

	private getLoadedExtensionsSummary(): Array<{ name: string; description?: string; toolCount: number }> {
		return buildLoadedExtensionsSummary(this.extensionManager);
	}

	private getProjectId(): string {
		return this.name.startsWith('agent:') ? this.name.slice(6) : this.name;
	}
}
