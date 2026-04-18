import { ExtensionManager } from '@cloudflare/think/extensions';
import { Agent, callable } from 'agents';
import { SessionManager } from 'agents/experimental/memory/session';
import { createCompactFunction } from 'agents/experimental/memory/utils';
import { generateText } from 'ai';
import { env } from 'cloudflare:workers';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { mount, withMounts } from 'worker-fs-mount';

import {
	AGENT_SYSTEM_PROMPT,
	DEFAULT_AI_MODEL,
	MAX_AI_SESSIONS_PER_PROJECT,
	SUMMARIZATION_AI_MODEL,
	getModelConfig,
} from '@shared/constants';
import { pendingChangesFileSchema, sessionTitleSchema } from '@shared/validation';

import {
	buildLoadedExtensionsSummary,
	buildTerminalNotification,
	buildRecoveredRunParameters,
	parseFiberSnapshot,
	restoreExtensionManager,
	runSessionSearch,
} from './agent-runner-helpers';
import {
	deletePendingChanges,
	deleteSessionMessageMetadata,
	deleteSessionMetadata,
	getDatabase,
	readPendingChangesData,
	updateSessionMetadataTitleGenerated,
	upsertSessionMetadata,
	writePendingChangesData,
} from './db';
import { getCommittedMessages, mergeQueuedMessages, promoteNextQueuedMessage } from './session-history';
import { AgentSessionStore } from './session-store';
import { SessionStreamState } from './session-stream-state';
import { trackAiUsage, trackWebSocketEvent } from '../lib/analytics';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';
import migrations from '../migrations/do-agent/migrations.js';
import { AIAgentService } from '../services/ai-agent';
import { chatMessagesToModelMessages, estimateMessagesTokens } from '../services/ai-agent/context-pruner';
import { accumulatePendingChange } from '../services/ai-agent/pending-changes';
import { isRequestOriginContext } from '../services/ai-agent/request-origin-context';
import { cleanupSessionArtifacts, cleanupTimestampPlans } from '../services/ai-agent/session-cleanup';
import { sessionMessagesToChatMessages } from '../services/ai-agent/session-messages';
import { readAgentsContext } from '../services/ai-agent/system-prompt-builder';
import { deriveFallbackTitle, generateSessionTitle } from '../services/ai-agent/title-generator';
import { createAdapter as createWorkersAiAdapter } from '../services/ai-agent/workers-ai';

import type { AgentDatabase } from './db';
import type { RequestOriginContext } from '../services/ai-agent/request-origin-context';
import type { AgentState, AgentSessionState, FiberSnapshot, SessionSummary } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, AgentSessionStatus, AiSession, ChatMessage, PendingFileChange } from '@shared/types';

const REQUEST_ORIGIN_CONTEXT_STORAGE_KEY = 'request-origin-context';
const SESSION_COMPACTION_THRESHOLD = 100_000;
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
	private agentSessionStore!: AgentSessionStore;
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
		.onCompaction(
			createCompactFunction({
				summarize: async (prompt) => {
					const { text } = await generateText({
						model: createWorkersAiAdapter(SUMMARIZATION_AI_MODEL),
						prompt,
						maxOutputTokens: 4096,
					});
					return text;
				},
			}),
		)
		.compactAfter(SESSION_COMPACTION_THRESHOLD)
		.withCachedPrompt()
		.withSearchableHistory('history');

	// ---- Volatile in-memory state (lost on eviction) ----
	private abortControllers = new Map<string, AbortController>();
	private loopPromises = new Map<string, Promise<void>>();
	private titleGenerationInFlight = new Set<string>();
	private sessionStreamState = new SessionStreamState({
		getCurrentSession: () => this.state.currentSession,
		updateSessionState: (sessionId, patch) => this.updateSessionState(sessionId, patch),
		readSession: (sessionId) => this.agentSessionStore.read(sessionId),
		getSessionInitiatorUserId: (sessionId) => this.sessionInitiatorUserIds.get(sessionId),
		sendPushNotification: (userId, sessionId, title, body) => this.sendPushNotification(userId, sessionId, title, body),
		recordToolCall: (sessionId) => {
			const analytics = this.sessionAnalytics.get(sessionId);
			if (analytics) {
				analytics.toolCallCount += 1;
			}
		},
		recordTurnComplete: (sessionId) => {
			const analytics = this.sessionAnalytics.get(sessionId);
			if (analytics) {
				analytics.turnNumber += 1;
			}
		},
		recordUsage: (sessionId, inputTokens, outputTokens) => {
			const analytics = this.sessionAnalytics.get(sessionId);
			if (analytics) {
				analytics.inputTokens = inputTokens;
				analytics.outputTokens = outputTokens;
			}
		},
	});
	private sessionInitiatorUserIds = new Map<string, string>();
	private connectionUserIds = new Map<string, string>();
	private requestOriginContext?: RequestOriginContext;
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
		const baseDomain = context.request?.headers.get('x-worker-ide-base-domain');
		const protocol = context.request?.headers.get('x-worker-ide-protocol');
		if (userId) {
			this.connectionUserIds.set(connection.id, userId);
		}
		if (baseDomain && protocol) {
			this.persistRequestOriginContext({ baseDomain, protocol });
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

	private persistRequestOriginContext(context: RequestOriginContext): void {
		this.requestOriginContext = context;
		this.ctx.storage.kv.put(REQUEST_ORIGIN_CONTEXT_STORAGE_KEY, context);
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
		this.agentSessionStore = new AgentSessionStore(this.db, this.sessionManager);
		await migrate(this.db, migrations);
		this.extensionManager = await restoreExtensionManager(env.LOADER, this.ctx.storage);
		const persistedRequestOriginContext = this.ctx.storage.kv.get<RequestOriginContext>(REQUEST_ORIGIN_CONTEXT_STORAGE_KEY);
		this.requestOriginContext = isRequestOriginContext(persistedRequestOriginContext) ? persistedRequestOriginContext : undefined;
		await this.refreshSessionsList();
		for (const sessionInfo of this.sessionManager.list()) {
			const session = this.agentSessionStore.read(sessionInfo.id);
			if (!session?.stopRequested) {
				continue;
			}
			if (this.abortControllers.has(sessionInfo.id)) {
				continue;
			}
			await this.maybeStartNextQueuedRun(this.getProjectId(), sessionInfo.id, this.sessionInitiatorUserIds.get(sessionInfo.id)).catch(
				(error) => {
					console.error('[AgentRunner] Failed to recover queued follow-up run:', error);
				},
			);
		}
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
	 * Start a new agent run for the committed session history.
	 */
	private async startAgentRun(
		projectId: string,
		messages: ChatMessage[],
		mode: AgentMode = 'code',
		model: AIModelId = DEFAULT_AI_MODEL,
		sessionId: string,
		initiatorUserId: string | undefined,
	): Promise<{ sessionId: string }> {
		// Rate limiting keyed on projectId — the DO is 1:1 with a project.
		// Never use client-supplied context for rate-limit keys.
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

		if (this.abortControllers.has(sessionId)) {
			return { sessionId };
		}

		const parameters: StartAgentParameters = {
			projectId,
			messages,
			mode,
			sessionId,
			model,
			initiatorUserId,
		};

		await this.launchAgentLoop(parameters, sessionId);

		this.sessionAnalytics.set(sessionId, {
			inputTokens: 0,
			outputTokens: 0,
			durationMs: Date.now(),
			toolCallCount: 0,
			turnNumber: 0,
		});

		trackAiUsage({
			userId: initiatorUserId ?? '',
			eventType: 'session_start',
			projectId,
			modelId: model,
			sessionId,
			agentMode: mode,
			inputTokens: 0,
			outputTokens: 0,
			durationMs: 0,
			toolCallCount: 0,
			turnNumber: 0,
		});

		this.updateSessionState(sessionId, {
			status: 'running',
			statusText: 'Starting...',
			messages: this.getSessionHistory(sessionId),
			error: undefined,
			stopRequested: false,
			pendingQuestion: undefined,
			needsContinuation: false,
			doomLoopMessage: undefined,
			subAgentActivities: {},
		});

		return { sessionId };
	}

	@callable()
	async submitMessage(
		projectId: string,
		messageText: string,
		sessionId?: string,
		mode: AgentMode = 'code',
		model: AIModelId = DEFAULT_AI_MODEL,
		messageId?: string,
		createdAt?: number,
	): Promise<{ sessionId: string; queued: boolean; started: boolean }> {
		const trimmedMessage = messageText.trim();
		if (!trimmedMessage) {
			throw new Error('Message is required.');
		}

		const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
		const authenticatedUserId = this.getAuthenticatedUserId();
		const persistedSession = this.agentSessionStore.read(resolvedSessionId);
		const persistedHistory = persistedSession?.history ?? [];
		const liveHistory = this.state.currentSession?.sessionId === resolvedSessionId ? this.state.currentSession.messages : persistedHistory;
		const stopRequested = persistedSession?.stopRequested ?? false;
		const isRunActive = this.abortControllers.has(resolvedSessionId);
		const shouldQueue = isRunActive || stopRequested;
		const userMessage = this.buildUserMessage(trimmedMessage, mode, model, shouldQueue ? 'queued' : 'committed', messageId, createdAt);

		const promptPreview = deriveFallbackTitle(trimmedMessage, 80);
		this.ensureSessionRecord(resolvedSessionId, promptPreview, model, mode);

		const durableHistory = [...persistedHistory, userMessage];
		await this.agentSessionStore.persistHistory(resolvedSessionId, durableHistory, stopRequested);

		if (shouldQueue) {
			this.updateSessionState(resolvedSessionId, {
				messages: [...liveHistory, userMessage],
				stopRequested,
				status:
					this.state.currentSession?.sessionId === resolvedSessionId ? this.state.currentSession.status : isRunActive ? 'running' : 'idle',
				statusText:
					this.state.currentSession?.sessionId === resolvedSessionId
						? this.state.currentSession.statusText
						: persistedSession?.status === 'running'
							? 'Thinking...'
							: undefined,
			});
			return { sessionId: resolvedSessionId, queued: true, started: false };
		}

		await this.startAgentRun(projectId, getCommittedMessages(durableHistory), mode, model, resolvedSessionId, authenticatedUserId);
		return { sessionId: resolvedSessionId, queued: false, started: true };
	}

	@callable()
	async removeQueuedMessage(sessionId: string, messageId: string): Promise<{ removed: boolean }> {
		const session = this.agentSessionStore.read(sessionId);
		if (!session) {
			return { removed: false };
		}

		const nextHistory = session.history.filter(
			(message) => !(message.id === messageId && message.role === 'user' && message.metadata?.request?.state === 'queued'),
		);
		if (nextHistory.length === session.history.length) {
			return { removed: false };
		}

		this.sessionManager.deleteMessages(sessionId, [messageId]);
		deleteSessionMessageMetadata(this.db, sessionId, [messageId]);
		this.agentSessionStore.writeMetadata(sessionId, { stopRequested: session.stopRequested });
		if (this.state.currentSession?.sessionId === sessionId) {
			this.updateSessionState(sessionId, { messages: nextHistory, stopRequested: session.stopRequested ?? false });
		}

		return { removed: true };
	}

	@callable()
	async startRun(
		projectId: string,
		messages: ChatMessage[],
		mode: AgentMode = 'code',
		model: AIModelId = DEFAULT_AI_MODEL,
		sessionId?: string,
	): Promise<{ sessionId: string }> {
		const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
		const authenticatedUserId = this.getAuthenticatedUserId();
		const promptPreview = deriveFallbackTitle(
			messages
				.toReversed()
				.find((message) => message.role === 'user')
				?.parts.filter((part): part is { type: 'text'; content: string } => part.type === 'text')
				.map((part) => part.content)
				.join(' ') ?? '',
			80,
		);

		this.ensureSessionRecord(resolvedSessionId, promptPreview, model, mode);
		const normalizedMessages = messages.map((message) => {
			if (message.role !== 'user') {
				return message;
			}

			const normalizedMessage: ChatMessage = {
				...message,
				metadata: {
					...message.metadata,
					request: {
						mode: message.metadata?.request?.mode ?? mode,
						model: message.metadata?.request?.model ?? model,
						state: 'committed',
					},
				},
			};

			return normalizedMessage;
		});

		await this.agentSessionStore.persistHistory(resolvedSessionId, normalizedMessages, false);
		return this.startAgentRun(projectId, getCommittedMessages(normalizedMessages), mode, model, resolvedSessionId, authenticatedUserId);
	}

	@callable()
	async abortRun(sessionId?: string): Promise<void> {
		if (sessionId) {
			const session = this.agentSessionStore.read(sessionId);
			if (!session) {
				return;
			}

			await this.agentSessionStore.persistHistory(sessionId, session.history, true);
			this.updateSessionState(sessionId, {
				stopRequested: true,
				statusText: 'Stopping...',
			});

			const controller = this.abortControllers.get(sessionId);
			if (controller) {
				controller.abort();
			}

			const loopPromise = this.loopPromises.get(sessionId);
			if (loopPromise) {
				await loopPromise.catch(() => {});
			}
			return;
		}

		for (const [runningSessionId, controller] of this.abortControllers.entries()) {
			const session = this.agentSessionStore.read(runningSessionId);
			if (session) {
				await this.agentSessionStore.persistHistory(runningSessionId, session.history, true);
				this.updateSessionState(runningSessionId, {
					stopRequested: true,
					statusText: 'Stopping...',
				});
			}
			controller.abort();
		}

		await Promise.allSettled(this.loopPromises.values());
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
		const session = this.agentSessionStore.read(sessionId);
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
				statusText: isRunning ? (session.stopRequested ? 'Stopping...' : 'Thinking...') : undefined,
				error: session.errorMessage ? { message: session.errorMessage } : undefined,
				contextTokensUsed: session.contextTokensUsed ?? 0,
				pendingChanges: pendingChangesMap,
				toolMetadata: session.toolMetadata ?? {},
				toolErrors: session.toolErrors ?? {},
				debugLogId: undefined,
				stopRequested: session.stopRequested ?? false,
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
		return runSessionSearch(query, limit, async (trimmedQuery, resolvedLimit) => {
			const matches = this.sessionManager.search(trimmedQuery, { limit: resolvedLimit });
			const results: Array<{ sessionId: string; role: string; content: string }> = [];
			for (const match of matches) {
				const sessionId = this.lookupSessionIdForMessage(match.id);
				if (!sessionId) {
					continue;
				}
				results.push({ sessionId, role: match.role, content: match.content });
			}
			return results;
		});
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
		const sourceAiSession = this.agentSessionStore.read(sessionId);
		const sourceMetadataByMessageId = new Map(sourceAiSession?.history.map((message) => [message.id, message.metadata]));
		const forkedHistory = sessionMessagesToChatMessages(this.sessionManager.getHistory(forkedSession.id));
		const truncatedHistory = forkedHistory.map((message) => ({
			...message,
			metadata: sourceMetadataByMessageId.get(message.id),
		}));
		const sourceMetadata = this.agentSessionStore.getMetadata(sessionId);
		const modelMessages = chatMessagesToModelMessages(truncatedHistory);
		const contextTokensUsed = estimateMessagesTokens(modelMessages);
		await this.agentSessionStore.replaceHistory(forkedSession.id, truncatedHistory);
		upsertSessionMetadata(this.db, {
			id: forkedSession.id,
			titleGenerated: sourceMetadata.titleGenerated ? 1 : 0,
			contextTokensUsed: contextTokensUsed > 0 ? contextTokensUsed : undefined,
			toolMetadata: undefined,
			toolErrors: undefined,
			status: 'idle',
			errorMessage: undefined,
			stopRequested: 0,
		});

		// Filter pending changes: keep entries from other sessions, or from this
		// session only if their snapshotId survives the truncation.
		const survivingSnapshotIds = new Set(
			truncatedHistory
				.map((message) => message.metadata?.snapshotId)
				.filter((snapshotId): snapshotId is string => typeof snapshotId === 'string'),
		);
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
				toolMetadata: {},
				toolErrors: {},
				stopRequested: false,
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
		this.sessionStreamState.disposeSession(sessionId);
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
		const promptPreview = deriveFallbackTitle(lastUserText, 80);

		const existing = this.sessionManager.get(sessionId);
		if (!existing) {
			this.ensureSessionRecord(sessionId, promptPreview, parameters.model, parameters.mode);
		}
		await this.agentSessionStore.replaceHistory(sessionId, parameters.messages);

		// Fire title generation independently
		if (lastUserText.length > 0 && !this.agentSessionStore.getMetadata(sessionId).titleGenerated) {
			void this.generateTitle(sessionId, lastUserText);
		}

		const loopPromise = this.executeAgentLoop(parameters, sessionId)
			.catch((error) => {
				console.error(`[AgentRunner ${sessionId}] Unhandled error from executeAgentLoop:`, error);
			})
			.finally(() => {
				if (this.loopPromises.get(sessionId) === loopPromise) {
					this.loopPromises.delete(sessionId);
				}
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
		const session = this.agentSessionStore.read(sessionId);
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
				false,
				session,
				this.extensionManager,
				env.LOADER,
				env.BROWSER,
				this,
				this.requestOriginContext,
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
				this.sessionStreamState.handleEvent(sessionId, event);
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
			this.sessionStreamState.disposeSession(sessionId);

			// Clean up in-memory state
			this.abortControllers.delete(sessionId);

			// Update state with terminal status
			this.updateSessionState(sessionId, {
				status: finalStatus,
				statusText: undefined,
				error: finalStatus === 'error' && errorMessage ? { message: errorMessage } : undefined,
				stopRequested: false,
			});

			this.agentSessionStore.writeMetadata(sessionId, {
				status: finalStatus,
				errorMessage,
				stopRequested: false,
			});

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

			const initiatorUserId = this.sessionInitiatorUserIds.get(sessionId);

			const startedNextRun = await this.maybeStartNextQueuedRun(projectId, sessionId, initiatorUserId).catch((nextRunError) => {
				console.error('[AgentRunner] Failed to start queued follow-up run:', nextRunError);
				return false;
			});
			const terminalNotification = buildTerminalNotification(finalStatus, errorMessage, startedNextRun);

			// Only notify once the queue drains; the final auto-started run will notify when the agent becomes idle.
			if (initiatorUserId && terminalNotification) {
				this.sendPushNotification(initiatorUserId, sessionId, terminalNotification.title, terminalNotification.body);
			}

			if (!startedNextRun) {
				this.sessionInitiatorUserIds.delete(sessionId);
			}

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

	// =========================================================================
	// Session Persistence (called by AIAgentService)
	// =========================================================================

	private async persistSessionFromService(
		sessionId: string,
		sessionData: import('../services/ai-agent/types').SessionPersistData,
	): Promise<void> {
		const existing = this.agentSessionStore.getMetadata(sessionId);
		const toolMetadata = { ...existing.toolMetadata, ...sessionData.toolMetadata };
		const toolErrors = { ...existing.toolErrors, ...sessionData.toolErrors };
		const mergedHistory = mergeQueuedMessages(sessionData.history, this.getSessionHistory(sessionId));

		await this.agentSessionStore.replaceHistory(sessionId, mergedHistory);

		this.agentSessionStore.writeMetadata(sessionId, {
			titleGenerated: existing.titleGenerated,
			contextTokensUsed: sessionData.contextTokensUsed,
			toolMetadata: Object.keys(toolMetadata).length > 0 ? toolMetadata : undefined,
			toolErrors: Object.keys(toolErrors).length > 0 ? toolErrors : undefined,
			status: sessionData.error ? 'error' : existing.status,
			errorMessage: sessionData.error?.message ?? existing.errorMessage,
			stopRequested: existing.stopRequested,
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
			const session = this.agentSessionStore.read(sessionId);
			const newState: AgentSessionState = {
				sessionId,
				title: session?.title ?? 'New session',
				status: 'idle',
				messages: session?.history ?? [],
				statusText: undefined,
				error: undefined,
				contextTokensUsed: session?.contextTokensUsed ?? 0,
				pendingChanges: this.loadPendingChangesFromDatabase(),
				toolMetadata: session?.toolMetadata ?? {},
				toolErrors: session?.toolErrors ?? {},
				debugLogId: undefined,
				stopRequested: session?.stopRequested ?? false,
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
	private buildUserMessage(
		content: string,
		mode: AgentMode,
		model: AIModelId,
		state: 'queued' | 'committed',
		messageId = crypto.randomUUID(),
		createdAt = Date.now(),
	): ChatMessage {
		return {
			id: messageId,
			role: 'user',
			parts: [{ type: 'text', content }],
			createdAt,
			metadata: {
				request: {
					mode,
					model,
					state,
				},
			},
		};
	}

	private getSessionHistory(sessionId: string): ChatMessage[] {
		return this.agentSessionStore.getHistory(sessionId);
	}

	private lookupSessionIdForMessage(messageId: string): string | undefined {
		const row = this.sql<{ sessionId: string }>`
			SELECT session_id as sessionId
			FROM assistant_messages
			WHERE id = ${messageId}
			LIMIT 1
		`[0];
		return row?.sessionId;
	}

	private async maybeStartNextQueuedRun(projectId: string, sessionId: string, initiatorUserId: string | undefined): Promise<boolean> {
		const session = this.agentSessionStore.read(sessionId);
		if (!session) {
			return false;
		}

		const { history, promotedMessage } = promoteNextQueuedMessage(session.history);
		if (!promotedMessage) {
			await this.agentSessionStore.persistHistory(sessionId, session.history, false);
			return false;
		}

		const request = promotedMessage.metadata?.request;
		const mode = request?.mode ?? 'code';
		const model = request?.model ?? DEFAULT_AI_MODEL;
		const committedMessages = getCommittedMessages(history);

		await this.agentSessionStore.persistHistory(sessionId, history, false);
		await this.startAgentRun(projectId, committedMessages, mode, model, sessionId, initiatorUserId);
		return true;
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
