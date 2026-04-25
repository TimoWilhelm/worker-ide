import { ExtensionManager } from '@cloudflare/think/extensions';
import { Agent, callable, getCurrentAgent } from 'agents';
import { AgentSearchProvider, SessionManager } from 'agents/experimental/memory/session';
import { createCompactFunction } from 'agents/experimental/memory/utils';
import { generateText } from 'ai';
import { env } from 'cloudflare:workers';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { mount, withMounts } from 'worker-fs-mount';

import { messagePartsHaveUserContent, messagePartsToPromptText } from '@shared/chat-message-parts';
import {
	AGENT_SYSTEM_PROMPT,
	COLLAB_COLORS,
	DEFAULT_AI_MODEL,
	MAX_AI_SESSIONS_PER_PROJECT,
	SUMMARIZATION_AI_MODEL,
	getModelConfig,
} from '@shared/constants';
import { sanitizePreviewElementReference } from '@shared/preview-element';
import { buildProjectDeepLinkPath } from '@shared/project-deep-link';
import {
	pendingChangesFileSchema,
	reviewHunkUpdateSchema,
	reviewResolveManySchema,
	reviewResolveSchema,
	sessionTitleSchema,
} from '@shared/validation';

import {
	buildLoadedExtensionsSummary,
	buildTerminalNotification,
	buildRecoveredRunParameters,
	parseFiberSnapshot,
	resolveInitialPendingChanges,
	restoreExtensionManager,
	runSessionSearch,
} from './agent-runner-helpers';
import {
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
import * as authSchema from '../db/auth-schema';
import { trackAiUsage, trackWebSocketEvent } from '../lib/analytics';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';
import { AIAgentService } from '../services/ai-agent';
import { chatMessagesToModelMessages, estimateMessagesTokens } from '../services/ai-agent/context-pruner';
import {
	ARTIFACTS_CONTEXT_LABEL,
	HISTORY_CONTEXT_LABEL,
	ROOT_MEMORY_CONTEXT_LABEL,
	type SearchableArtifactEntry,
} from '../services/ai-agent/memory/artifacts';
import { SharedContextProvider } from '../services/ai-agent/memory/shared-context-provider';
import { isRequestOriginContext } from '../services/ai-agent/request-origin-context';
import { ReviewQueueStore } from '../services/ai-agent/review-queue';
import { cleanupSessionArtifacts, cleanupTimestampPlans } from '../services/ai-agent/session-cleanup';
import { sessionMessagesToChatMessages } from '../services/ai-agent/session-messages';
import { readAgentsContext } from '../services/ai-agent/system-prompt-builder';
import { deriveFallbackTitle, generateSessionTitle } from '../services/ai-agent/title-generator';
import { createAdapter as createWorkersAiAdapter } from '../services/ai-agent/workers-ai';

import type { AgentDatabase } from './db';
import type { RequestOriginContext } from '../services/ai-agent/request-origin-context';
import type { AgentState, AgentSessionState, FiberSnapshot, SessionParticipantProfile, SessionSummary } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, AgentSessionStatus, AiSession, ChatMessage, PendingFileChange, ReviewEntry, UserMessagePart } from '@shared/types';

const REQUEST_ORIGIN_CONTEXT_STORAGE_KEY = 'request-origin-context';
const SESSION_COMPACTION_THRESHOLD = 100_000;
const SESSION_COMPACTION_PROTECT_HEAD = 3;
const SESSION_COMPACTION_TAIL_TOKEN_BUDGET = 32_000;
const SESSION_COMPACTION_MIN_TAIL_MESSAGES = 4;
const ROOT_MEMORY_MAX_TOKENS = 2000;
const PROJECT_ROOT = '/project';
const MAX_SESSIONS = MAX_AI_SESSIONS_PER_PROJECT;

type AgentConnection = import('agents').Connection<unknown>;

interface ConnectionIdentityAttachment extends SessionParticipantProfile {
	userId: string;
}

function isConnectionIdentityAttachment(value: unknown): value is ConnectionIdentityAttachment {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}

	return (
		'userId' in value &&
		typeof value.userId === 'string' &&
		'name' in value &&
		typeof value.name === 'string' &&
		'color' in value &&
		typeof value.color === 'string' &&
		(!('image' in value) || typeof value.image === 'string' || value.image === undefined)
	);
}

function hashString(value: string): number {
	let hash = 0;
	for (const character of value) {
		hash = (hash << 5) - hash + (character.codePointAt(0) ?? 0);
		hash = Math.trunc(hash);
	}
	return Math.abs(hash);
}

function getParticipantColor(userId: string): string {
	return COLLAB_COLORS[hashString(userId) % COLLAB_COLORS.length] ?? COLLAB_COLORS[0];
}

function getParticipantProfile(identity: ConnectionIdentityAttachment): SessionParticipantProfile {
	return {
		name: identity.name,
		image: identity.image,
		color: identity.color,
	};
}

function sanitizeSubmittedUserMessageParts(parts: unknown): UserMessagePart[] {
	if (!Array.isArray(parts)) {
		return [];
	}

	const sanitizedParts: UserMessagePart[] = [];
	for (const part of parts) {
		if (!part || typeof part !== 'object' || Array.isArray(part) || !('type' in part) || typeof part.type !== 'string') {
			continue;
		}

		if (part.type === 'text' && 'content' in part && typeof part.content === 'string') {
			const previousPart = sanitizedParts.at(-1);
			if (previousPart?.type === 'text') {
				previousPart.content += part.content;
			} else {
				sanitizedParts.push({ type: 'text', content: part.content });
			}
			continue;
		}

		if (part.type === 'preview-element') {
			const sanitizedReference = sanitizePreviewElementReference(part);
			if (sanitizedReference) {
				sanitizedParts.push({ type: 'preview-element', ...sanitizedReference });
			}
		}
	}

	return sanitizedParts;
}

function getUserMessagePromptText(parts: readonly UserMessagePart[]): string {
	return messagePartsToPromptText(parts).trim();
}

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
		sessionParticipants: {},
		reviewEntries: {},
		reviewSummary: { unresolvedCount: 0, reviewVersion: 0, sessionCounts: {} },
	};

	// ---- Drizzle database instance (initialized in onStart) ----

	private db!: AgentDatabase;
	private agentSessionStore!: AgentSessionStore;
	private reviewQueue!: ReviewQueueStore;
	private extensionManager?: ExtensionManager;
	private reviewVersion = 0;
	private rootMemoryProvider = new SharedContextProvider(this, ROOT_MEMORY_CONTEXT_LABEL);
	private artifactsProvider = new AgentSearchProvider(this);
	private artifactsContextProvider = {
		init: (label: string) => {
			this.artifactsProvider.init(label);
		},
		get: async () => this.artifactsProvider.get(),
		search: async (query: string) => this.artifactsProvider.search(query),
	};
	private sessionManager = SessionManager.create(this)
		.withContext('soul', {
			provider: {
				get: async () => this.getSoulPrompt(),
			},
		})
		.withContext(ROOT_MEMORY_CONTEXT_LABEL, {
			description: 'Important facts about this project learned across sessions.',
			maxTokens: ROOT_MEMORY_MAX_TOKENS,
			provider: this.rootMemoryProvider,
		})
		.withContext(ARTIFACTS_CONTEXT_LABEL, {
			description: 'Searchable project artifacts such as plans, todos, diagnostics, and sub-agent reports.',
			provider: this.artifactsContextProvider,
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
				protectHead: SESSION_COMPACTION_PROTECT_HEAD,
				tailTokenBudget: SESSION_COMPACTION_TAIL_TOKEN_BUDGET,
				minTailMessages: SESSION_COMPACTION_MIN_TAIL_MESSAGES,
			}),
		)
		.compactAfter(SESSION_COMPACTION_THRESHOLD)
		.withCachedPrompt()
		.withSearchableHistory(HISTORY_CONTEXT_LABEL);

	// ---- Volatile in-memory state (lost on eviction) ----
	private abortControllers = new Map<string, AbortController>();
	private loopPromises = new Map<string, Promise<void>>();
	private titleGenerationInFlight = new Set<string>();
	private startRunRequestCache = new Map<string, { expiresAt: number; promise: Promise<{ sessionId: string }> }>();
	private submitMessageRequestCache = new Map<
		string,
		{ expiresAt: number; promise: Promise<{ sessionId: string; queued: boolean; started: boolean }> }
	>();
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
	private requestOriginContext?: RequestOriginContext;
	private sessionMutationTails = new Map<string, Promise<void>>();
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
		if (
			typeof nextState.sessionParticipants !== 'object' ||
			Array.isArray(nextState.sessionParticipants) ||
			!nextState.sessionParticipants
		) {
			throw new TypeError('AgentState.sessionParticipants must be an object');
		}
	}

	private async withSessionMutationLock<T>(sessionId: string, callback: () => Promise<T>): Promise<T> {
		const previousTail = this.sessionMutationTails.get(sessionId) ?? Promise.resolve();
		let resolveCurrentTail: (() => void) | undefined;
		const currentTail = new Promise<void>((resolve) => {
			resolveCurrentTail = resolve;
		});
		const nextTail = previousTail.catch(() => {}).then(() => currentTail);
		this.sessionMutationTails.set(sessionId, nextTail);

		await previousTail.catch(() => {});

		try {
			return await callback();
		} finally {
			resolveCurrentTail?.();
			if (this.sessionMutationTails.get(sessionId) === nextTail) {
				this.sessionMutationTails.delete(sessionId);
			}
		}
	}

	private withRpcRequestCache<T>(
		cache: Map<string, { expiresAt: number; promise: Promise<T> }>,
		cacheKey: string | undefined,
		callback: () => Promise<T>,
	): Promise<T> {
		if (!cacheKey) {
			return callback();
		}

		const now = Date.now();
		for (const [key, value] of cache) {
			if (value.expiresAt <= now) {
				cache.delete(key);
			}
		}

		const cached = cache.get(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.promise;
		}

		const promise = callback();
		cache.set(cacheKey, {
			expiresAt: now + 60_000,
			promise,
		});

		void promise.catch(() => {
			if (cache.get(cacheKey)?.promise === promise) {
				cache.delete(cacheKey);
			}
		});

		return promise;
	}

	// =========================================================================
	// WebSocket Lifecycle
	// =========================================================================

	/**
	 * Called by the Agents SDK when a new WebSocket connection is established.
	 * Extracts the authenticated userId forwarded by the main Worker and stores
	 * the resolved user identity in the WebSocket attachment so it survives
	 * hibernation and can be read back from @callable methods.
	 */
	async onConnect(connection: AgentConnection, context: import('agents').ConnectionContext): Promise<void> {
		await super.onConnect(connection, context);
		const userId = context.request?.headers.get('x-worker-ide-user-id');
		const baseDomain = context.request?.headers.get('x-worker-ide-base-domain');
		const protocol = context.request?.headers.get('x-worker-ide-protocol');
		if (userId) {
			const identity = await this.loadConnectionIdentity(userId);
			connection.serializeAttachment(identity);
			this.setSessionParticipants({
				...this.state.sessionParticipants,
				[identity.userId]: getParticipantProfile(identity),
			});
		}
		if (baseDomain && protocol) {
			this.persistRequestOriginContext({ baseDomain, protocol });
		}
		if (this.state.currentSession) {
			await this.syncStateSessionParticipants(this.state.currentSession.messages);
		}

		trackWebSocketEvent({
			projectId: this.ctx.id.toString(),
			eventType: 'connect',
			connectionType: 'agent',
			userId: userId ?? undefined,
			concurrentConnections: this.getConnectedConnectionCount(),
		});
	}

	onClose(_connection: AgentConnection): void {
		trackWebSocketEvent({
			projectId: this.ctx.id.toString(),
			eventType: 'disconnect',
			connectionType: 'agent',
			concurrentConnections: this.getConnectedConnectionCount(),
		});
	}

	private getConnectionIdentity(connection: WebSocket | AgentConnection | undefined): ConnectionIdentityAttachment | undefined {
		if (!connection) {
			return undefined;
		}

		try {
			const attachment: unknown = connection.deserializeAttachment();
			return isConnectionIdentityAttachment(attachment) ? attachment : undefined;
		} catch {
			return undefined;
		}
	}

	private getCurrentCallerIdentity(): ConnectionIdentityAttachment | undefined {
		return this.getConnectionIdentity(getCurrentAgent().connection);
	}

	private getConnectedConnectionCount(): number {
		let count = 0;
		for (const connection of this.ctx.getWebSockets()) {
			if (connection.readyState === WebSocket.OPEN && this.getConnectionIdentity(connection)) {
				count += 1;
			}
		}
		return count;
	}

	private getLiveConnectionParticipants(): Record<string, SessionParticipantProfile> {
		const participants: Record<string, SessionParticipantProfile> = {};
		for (const connection of this.ctx.getWebSockets()) {
			if (connection.readyState !== WebSocket.OPEN) {
				continue;
			}
			const identity = this.getConnectionIdentity(connection);
			if (identity) {
				participants[identity.userId] = getParticipantProfile(identity);
			}
		}
		return participants;
	}

	private setSessionParticipants(sessionParticipants: Record<string, SessionParticipantProfile>): void {
		if (this.state.sessionParticipants === sessionParticipants) {
			return;
		}

		this.setState({
			...this.state,
			sessionParticipants,
		});
	}

	private async loadConnectionIdentity(userId: string): Promise<ConnectionIdentityAttachment> {
		// Failures here must never reject the WebSocket handshake — fall back to a
		// minimal identity so the connection still succeeds. The worst case is a
		// participant displayed as "Unknown" until their profile is refreshed.
		try {
			const database = drizzle(env.DB);
			const userRows = await database
				.select({ name: authSchema.user.name, image: authSchema.user.image })
				.from(authSchema.user)
				.where(eq(authSchema.user.id, userId))
				.limit(1);

			return {
				userId,
				name: userRows[0]?.name ?? 'Unknown',
				image: userRows[0]?.image ?? undefined,
				color: getParticipantColor(userId),
			};
		} catch (error) {
			console.error('[AgentRunner] Failed to load connection identity from D1:', error);
			return {
				userId,
				name: 'Unknown',
				color: getParticipantColor(userId),
			};
		}
	}

	private async resolveSessionParticipants(messages: readonly ChatMessage[]): Promise<Record<string, SessionParticipantProfile>> {
		const nextParticipants = { ...this.state.sessionParticipants };
		const unresolvedUserIds = new Set<string>();

		for (const message of messages) {
			if (!message.authorUserId || nextParticipants[message.authorUserId]) {
				continue;
			}

			const liveIdentity = [...this.ctx.getWebSockets()]
				.map((connection) => this.getConnectionIdentity(connection))
				.find((identity) => identity?.userId === message.authorUserId);
			if (liveIdentity) {
				nextParticipants[liveIdentity.userId] = getParticipantProfile(liveIdentity);
				continue;
			}

			unresolvedUserIds.add(message.authorUserId);
		}

		const missingUserIds = [...unresolvedUserIds];
		if (missingUserIds.length > 0) {
			const database = drizzle(env.DB);
			const userRows = await database
				.select({ id: authSchema.user.id, name: authSchema.user.name, image: authSchema.user.image })
				.from(authSchema.user)
				.where(inArray(authSchema.user.id, missingUserIds));

			for (const userRow of userRows) {
				nextParticipants[userRow.id] = {
					name: userRow.name,
					image: userRow.image ?? undefined,
					color: getParticipantColor(userRow.id),
				};
			}

			for (const userId of missingUserIds) {
				if (nextParticipants[userId]) {
					continue;
				}

				nextParticipants[userId] = {
					name: 'Unknown',
					color: getParticipantColor(userId),
				};
			}
		}

		return nextParticipants;
	}

	private async syncStateSessionParticipants(messages: readonly ChatMessage[]): Promise<Record<string, SessionParticipantProfile>> {
		const sessionParticipants = await this.resolveSessionParticipants(messages);
		this.setSessionParticipants(sessionParticipants);
		return sessionParticipants;
	}

	private persistRequestOriginContext(context: RequestOriginContext): void {
		this.requestOriginContext = context;
		this.ctx.storage.kv.put(REQUEST_ORIGIN_CONTEXT_STORAGE_KEY, context);
	}

	private resolveProjectIdFromRequest(request: Request): string {
		const roomName = request.headers.get('x-partykit-room');
		if (roomName?.startsWith('agent:')) {
			return roomName.slice(6);
		}
		return this.getProjectId();
	}

	// =========================================================================
	// HTTP Request Handler
	// =========================================================================

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const projectId = this.resolveProjectIdFromRequest(request);

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
				this.savePendingChangesToDatabase(parsed.data);
				this.reviewQueue.bootstrapLegacyPendingChanges(parsed.data);
				this.refreshReviewState();
				return new Response(undefined, { status: 204 });
			}
		}

		if (url.pathname === '/review' && request.method === 'GET') {
			return Response.json({ entries: this.reviewQueue.listReviewEntries() });
		}

		if (url.pathname === '/review/resolve-many' && request.method === 'POST') {
			const body: unknown = await request.json();
			const parsed = reviewResolveManySchema.safeParse(body);
			if (!parsed.success) {
				return Response.json({ error: 'Invalid review resolution' }, { status: 400, headers: { 'Content-Type': 'application/json' } });
			}
			await this.withProjectMount(async () => {
				await this.reviewQueue.resolveEntries(PROJECT_ROOT, projectId, parsed.data.decision, parsed.data.sessionId, parsed.data.reviewIds);
			}, projectId);
			this.refreshReviewState();
			return new Response(undefined, { status: 204 });
		}

		const reviewMatch = url.pathname.match(/^\/review\/([^/]+)\/(hunks|resolve)$/);
		if (reviewMatch) {
			const [, reviewId, action] = reviewMatch;
			if (!reviewId || !action) {
				return new Response('Not Found', { status: 404 });
			}
			if (action === 'hunks' && request.method === 'PUT') {
				const body: unknown = await request.json();
				const parsed = reviewHunkUpdateSchema.safeParse(body);
				if (!parsed.success) {
					return Response.json({ error: 'Invalid hunk update' }, { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				await this.withProjectMount(async () => {
					await this.reviewQueue.updateHunkStatuses(PROJECT_ROOT, projectId, reviewId, parsed.data.hunkStatuses);
				}, projectId);
				this.refreshReviewState();
				return new Response(undefined, { status: 204 });
			}
			if (action === 'resolve' && request.method === 'POST') {
				const body: unknown = await request.json();
				const parsed = reviewResolveSchema.safeParse(body);
				if (!parsed.success) {
					return Response.json({ error: 'Invalid review resolution' }, { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				await this.withProjectMount(async () => {
					await this.reviewQueue.resolveEntry(PROJECT_ROOT, projectId, reviewId, parsed.data.decision);
				}, projectId);
				this.refreshReviewState();
				return new Response(undefined, { status: 204 });
			}
		}

		if (url.pathname === '/review/sync-path' && request.method === 'POST') {
			const body: unknown = await request.json();
			const path = typeof body === 'object' && body && 'path' in body && typeof body.path === 'string' ? body.path : undefined;
			if (!path) {
				return Response.json({ error: 'Invalid path sync' }, { status: 400, headers: { 'Content-Type': 'application/json' } });
			}
			await this.withProjectMount(async () => {
				await this.reviewQueue.syncTrackedPathFromWorkspace(PROJECT_ROOT, path);
			}, projectId);
			this.refreshReviewState();
			return new Response(undefined, { status: 204 });
		}

		if (url.pathname === '/review/move-path' && request.method === 'POST') {
			const body: unknown = await request.json();
			const fromPath =
				typeof body === 'object' && body && 'fromPath' in body && typeof body.fromPath === 'string' ? body.fromPath : undefined;
			const toPath = typeof body === 'object' && body && 'toPath' in body && typeof body.toPath === 'string' ? body.toPath : undefined;
			if (!fromPath || !toPath) {
				return Response.json({ error: 'Invalid move sync' }, { status: 400, headers: { 'Content-Type': 'application/json' } });
			}
			this.reviewQueue.moveTrackedPath(fromPath, toPath);
			this.refreshReviewState();
			return new Response(undefined, { status: 204 });
		}

		return new Response('Not Found', { status: 404 });
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/**
	 * Called when the Agent starts (or wakes from hibernation / eviction).
	 * Initializes storage-backed helpers and restores extensions.
	 */
	async onStart(): Promise<void> {
		// MIGRATION: ensure sessionParticipants is an object
		if (!this.state.sessionParticipants || typeof this.state.sessionParticipants !== 'object') {
			this.setState({ ...this.state, sessionParticipants: {} });
		}

		this.db = getDatabase(this.ctx.storage);
		this.agentSessionStore = new AgentSessionStore(this.db, this.sessionManager);
		this.ensureAgentDatabaseTables();
		this.reviewQueue = new ReviewQueueStore(this.db);
		this.reviewQueue.bootstrapLegacyPendingChanges(this.loadPendingChangesFromDatabase());
		this.extensionManager = await restoreExtensionManager(env.LOADER, this.ctx.storage);
		const persistedRequestOriginContext = this.ctx.storage.kv.get<RequestOriginContext>(REQUEST_ORIGIN_CONTEXT_STORAGE_KEY);
		this.requestOriginContext = isRequestOriginContext(persistedRequestOriginContext) ? persistedRequestOriginContext : undefined;
		this.refreshReviewState();
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

		await this.syncStateSessionParticipants(messages);
		await this.refreshSessionPrompt(sessionId);

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
		parts: unknown,
		sessionId?: string,
		mode: AgentMode = 'code',
		model: AIModelId = DEFAULT_AI_MODEL,
		messageId?: string,
		createdAt?: number,
	): Promise<{ sessionId: string; queued: boolean; started: boolean }> {
		const sanitizedParts = sanitizeSubmittedUserMessageParts(parts);
		if (!messagePartsHaveUserContent(sanitizedParts)) {
			throw new Error('Message is required.');
		}

		const promptText = getUserMessagePromptText(sanitizedParts);

		const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

		return this.withRpcRequestCache(
			this.submitMessageRequestCache,
			messageId ? `submitMessage:${resolvedSessionId}:${messageId}` : undefined,
			async () => {
				const callerIdentity = this.getCurrentCallerIdentity();
				const authenticatedUserId = callerIdentity?.userId;

				return this.withSessionMutationLock(resolvedSessionId, async () => {
					const persistedSession = this.agentSessionStore.read(resolvedSessionId);
					const persistedHistory = persistedSession?.history ?? [];
					const duplicateMessage = messageId ? persistedHistory.find((message) => message.id === messageId) : undefined;
					if (duplicateMessage) {
						const duplicateQueued = duplicateMessage.role === 'user' && duplicateMessage.metadata?.request?.state === 'queued';
						return {
							sessionId: resolvedSessionId,
							queued: duplicateQueued,
							started: !duplicateQueued,
						};
					}

					if (callerIdentity) {
						this.setSessionParticipants({
							...this.state.sessionParticipants,
							[callerIdentity.userId]: getParticipantProfile(callerIdentity),
						});
					}

					const liveHistory =
						this.state.currentSession?.sessionId === resolvedSessionId ? this.state.currentSession.messages : persistedHistory;
					const stopRequested = persistedSession?.stopRequested ?? false;
					const isRunActive = this.abortControllers.has(resolvedSessionId);
					const shouldQueue = isRunActive || stopRequested;
					const userMessage = this.buildUserMessage(
						sanitizedParts,
						mode,
						model,
						shouldQueue ? 'queued' : 'committed',
						authenticatedUserId,
						messageId,
						createdAt,
					);

					const promptPreview = deriveFallbackTitle(promptText, 80);
					this.ensureSessionRecord(resolvedSessionId, promptPreview, model, mode);

					const durableHistory = [...persistedHistory, userMessage];
					await this.agentSessionStore.persistHistory(resolvedSessionId, durableHistory, stopRequested);

					if (shouldQueue) {
						this.updateSessionState(resolvedSessionId, {
							messages: [...liveHistory, userMessage],
							stopRequested,
							status:
								this.state.currentSession?.sessionId === resolvedSessionId
									? this.state.currentSession.status
									: isRunActive
										? 'running'
										: 'idle',
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
				});
			},
		);
	}

	@callable()
	async removeQueuedMessage(sessionId: string, messageId: string): Promise<{ removed: boolean }> {
		const callerIdentity = this.getCurrentCallerIdentity();

		return this.withSessionMutationLock(sessionId, async () => {
			const session = this.agentSessionStore.read(sessionId);
			if (!session) {
				return { removed: false };
			}

			const targetMessage = session.history.find(
				(message) => message.id === messageId && message.role === 'user' && message.metadata?.request?.state === 'queued',
			);
			if (!targetMessage) {
				return { removed: false };
			}

			// Only the author of a queued message may remove it. Legacy messages without
			// an authorUserId predate this tracking and are allowed through for any caller.
			if (targetMessage.authorUserId && targetMessage.authorUserId !== callerIdentity?.userId) {
				throw new Error('Not authorized to remove this queued message.');
			}

			const nextHistory = session.history.filter((message) => message.id !== messageId);

			this.sessionManager.deleteMessages(sessionId, [messageId]);
			deleteSessionMessageMetadata(this.db, sessionId, [messageId]);
			this.agentSessionStore.writeMetadata(sessionId, { stopRequested: session.stopRequested });
			if (this.state.currentSession?.sessionId === sessionId) {
				this.updateSessionState(sessionId, { messages: nextHistory, stopRequested: session.stopRequested ?? false });
			}

			return { removed: true };
		});
	}

	@callable()
	async startRun(
		projectId: string,
		messages: ChatMessage[],
		mode: AgentMode = 'code',
		model: AIModelId = DEFAULT_AI_MODEL,
		sessionId?: string,
		requestId?: string,
	): Promise<{ sessionId: string }> {
		const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

		return this.withRpcRequestCache(
			this.startRunRequestCache,
			requestId ? `startRun:${resolvedSessionId}:${requestId}` : undefined,
			async () => {
				const callerIdentity = this.getCurrentCallerIdentity();
				const authenticatedUserId = callerIdentity?.userId;

				return this.withSessionMutationLock(resolvedSessionId, async () => {
					const latestUserMessage = messages.toReversed().find((message) => message.role === 'user');
					const promptPreview = deriveFallbackTitle(latestUserMessage ? messagePartsToPromptText(latestUserMessage.parts).trim() : '', 80);

					this.ensureSessionRecord(resolvedSessionId, promptPreview, model, mode);
					if (callerIdentity) {
						this.setSessionParticipants({
							...this.state.sessionParticipants,
							[callerIdentity.userId]: getParticipantProfile(callerIdentity),
						});
					}

					const normalizedMessages = messages.map((message) => {
						if (message.role !== 'user') {
							return message;
						}

						const normalizedParts = sanitizeSubmittedUserMessageParts(message.parts);

						const normalizedMessage: ChatMessage = {
							...message,
							authorUserId: message.authorUserId ?? authenticatedUserId,
							parts: normalizedParts,
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
					return this.startAgentRun(
						projectId,
						getCommittedMessages(normalizedMessages),
						mode,
						model,
						resolvedSessionId,
						authenticatedUserId,
					);
				});
			},
		);
	}

	@callable()
	async abortRun(sessionId?: string): Promise<void> {
		if (sessionId) {
			await this.withSessionMutationLock(sessionId, async () => {
				const session = this.agentSessionStore.read(sessionId);
				if (!session) {
					return;
				}

				await this.agentSessionStore.persistHistory(sessionId, session.history, true);
				this.updateSessionState(sessionId, {
					stopRequested: true,
					statusText: 'Stopping...',
				});
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
			await this.withSessionMutationLock(runningSessionId, async () => {
				const session = this.agentSessionStore.read(runningSessionId);
				if (session) {
					await this.agentSessionStore.persistHistory(runningSessionId, session.history, true);
					this.updateSessionState(runningSessionId, {
						stopRequested: true,
						statusText: 'Stopping...',
					});
				}
			});
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
		const sessionParticipants = await this.resolveSessionParticipants(session.history);

		this.setState({
			...this.state,
			sessionParticipants,
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
			this.reviewQueue.removeSession(sessionId);
			this.refreshReviewState();
			// Clear the current session state so the frontend shows an empty chat
			if (this.state.currentSession?.sessionId === sessionId) {
				this.setState({
					...this.state,
					sessionParticipants: this.getLiveConnectionParticipants(),
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
		const sourceMessageStateByMessageId = new Map(
			sourceAiSession?.history.map((message) => [message.id, { authorUserId: message.authorUserId, metadata: message.metadata }]),
		);
		const forkedHistory = sessionMessagesToChatMessages(this.sessionManager.getHistory(forkedSession.id));
		const truncatedHistory = forkedHistory.map((message) => ({
			...message,
			authorUserId: sourceMessageStateByMessageId.get(message.id)?.authorUserId,
			metadata: sourceMessageStateByMessageId.get(message.id)?.metadata,
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
		const survivingSessionChanges: Record<string, PendingFileChange> = {};
		for (const [path, change] of Object.entries(globalChanges)) {
			if (change.sessionId === sessionId && change.snapshotId && survivingSnapshotIds.has(change.snapshotId)) {
				survivingSessionChanges[path] = { ...change, sessionId: forkedSession.id };
			}
		}
		this.reviewQueue.removeSession(sessionId);
		this.reviewQueue.syncSessionPendingChanges(forkedSession.id, survivingSessionChanges);
		this.refreshReviewState();

		// Update state for connected clients
		if (this.state.currentSession?.sessionId === sessionId) {
			const sessionParticipants = await this.resolveSessionParticipants(truncatedHistory);
			this.setState({
				...this.state,
				sessionParticipants,
				currentSession: {
					sessionId: forkedSession.id,
					title: forkedSession.name,
					status: 'idle',
					statusText: undefined,
					error: undefined,
					messages: truncatedHistory,
					contextTokensUsed,
					pendingChanges: this.loadPendingChangesFromDatabase(),
					toolMetadata: {},
					toolErrors: {},
					debugLogId: undefined,
					stopRequested: false,
					pendingQuestion: undefined,
					needsContinuation: false,
					doomLoopMessage: undefined,
					subAgentActivities: {},
					contextBlocksSummary: this.getContextBlocksSummary(forkedSession.id),
					extensions: this.getLoadedExtensionsSummary(),
				},
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
		this.reviewQueue.removeSession(sessionId);
		this.refreshReviewState();
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
			this.setState({
				...this.state,
				currentSession: undefined,
				sessionParticipants: this.getLiveConnectionParticipants(),
			});
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
		this.reviewQueue.bootstrapLegacyPendingChanges(changes);
		this.refreshReviewState();
	}
	@callable()
	async listReviewEntries(): Promise<ReviewEntry[]> {
		return this.reviewQueue.listReviewEntries();
	}
	@callable()
	async updateReviewHunks(reviewId: string, hunkStatuses: PendingFileChange['hunkStatuses']): Promise<void> {
		await this.withProjectMount(async () => {
			await this.reviewQueue.updateHunkStatuses(PROJECT_ROOT, this.getProjectId(), reviewId, hunkStatuses);
		});
		this.refreshReviewState();
	}
	@callable()
	async resolveReviewEntry(reviewId: string, decision: 'accept' | 'reject'): Promise<void> {
		await this.withProjectMount(async () => {
			await this.reviewQueue.resolveEntry(PROJECT_ROOT, this.getProjectId(), reviewId, decision);
		});
		this.refreshReviewState();
	}
	@callable()
	async resolveReviewEntries(decision: 'accept' | 'reject', sessionId?: string, reviewIds?: string[]): Promise<void> {
		await this.withProjectMount(async () => {
			await this.reviewQueue.resolveEntries(PROJECT_ROOT, this.getProjectId(), decision, sessionId, reviewIds);
		});
		this.refreshReviewState();
	}
	@callable()
	async syncReviewPathFromWorkspace(path: string): Promise<void> {
		await this.withProjectMount(async () => {
			await this.reviewQueue.syncTrackedPathFromWorkspace(PROJECT_ROOT, path);
		});
		this.refreshReviewState();
	}
	@callable()
	async moveTrackedReviewPath(fromPath: string, toPath: string): Promise<void> {
		this.reviewQueue.moveTrackedPath(fromPath, toPath);
		this.refreshReviewState();
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
		this.setState({
			...this.state,
			currentSession: undefined,
			sessionParticipants: this.getLiveConnectionParticipants(),
		});
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
		const lastUserText = lastUserMessage ? messagePartsToPromptText(lastUserMessage.parts).trim() : '';
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
			const initialPendingChanges = resolveInitialPendingChanges(
				parameters._fiberSnapshot,
				parameters._fiberSnapshot ? undefined : this.reviewQueue.readSessionPendingChanges(sessionId),
			);

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
				initialPendingChanges,
				(entry) => this.indexArtifact(entry),
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
		await this.withSessionMutationLock(sessionId, async () => {
			const existing = this.agentSessionStore.getMetadata(sessionId);
			const toolMetadata = { ...existing.toolMetadata, ...sessionData.toolMetadata };
			const toolErrors = { ...existing.toolErrors, ...sessionData.toolErrors };
			const mergedHistory = mergeQueuedMessages(sessionData.history, this.getSessionHistory(sessionId));

			await this.agentSessionStore.replaceHistory(sessionId, mergedHistory);
			await this.syncStateSessionParticipants(mergedHistory);

			this.agentSessionStore.writeMetadata(sessionId, {
				titleGenerated: existing.titleGenerated,
				contextTokensUsed: sessionData.contextTokensUsed,
				toolMetadata: Object.keys(toolMetadata).length > 0 ? toolMetadata : undefined,
				toolErrors: Object.keys(toolErrors).length > 0 ? toolErrors : undefined,
				status: sessionData.error ? 'error' : existing.status,
				errorMessage: sessionData.error?.message ?? existing.errorMessage,
				stopRequested: existing.stopRequested,
			});

			this.reviewQueue.syncSessionPendingChanges(sessionId, sessionData.pendingChanges ?? {});
			this.refreshReviewState();

			if (sessionData.fiberSnapshot) {
				this.stash(sessionData.fiberSnapshot);
			}
		});
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
			this.reviewQueue.removeSession(id);
		}

		this.refreshReviewState();
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

	private refreshReviewState(): void {
		this.reviewVersion = Date.now();
		this.setState({
			...this.state,
			reviewEntries: this.reviewQueue.listReviewEntriesRecord(),
			reviewSummary: this.reviewQueue.getReviewSummary(this.reviewVersion),
			currentSession: this.state.currentSession
				? {
						...this.state.currentSession,
						pendingChanges: this.loadPendingChangesFromDatabase(),
					}
				: undefined,
		});
	}

	private ensureAgentDatabaseTables(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS pending_changes (
				id INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
				data TEXT DEFAULT '{}' NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session_metadata (
				id TEXT PRIMARY KEY NOT NULL,
				title_generated INTEGER DEFAULT 0 NOT NULL,
				context_tokens_used INTEGER,
				tool_metadata TEXT,
				tool_errors TEXT,
				status TEXT,
				error_message TEXT,
				stop_requested INTEGER DEFAULT 0 NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session_message_metadata (
				session_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				request_mode TEXT,
				request_model TEXT,
				request_state TEXT,
				author_user_id TEXT,
				parts_json TEXT,
				snapshot_id TEXT,
				PRIMARY KEY(session_id, message_id)
			)
		`);
		try {
			this.ctx.storage.sql.exec('ALTER TABLE session_message_metadata ADD COLUMN parts_json TEXT');
		} catch {
			// Column already exists.
		}
		try {
			this.ctx.storage.sql.exec('ALTER TABLE session_message_metadata ADD COLUMN author_user_id TEXT');
		} catch {
			// Column already exists.
		}
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session_pending_changes (
				session_id TEXT PRIMARY KEY NOT NULL,
				data TEXT DEFAULT '{}' NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session_pending_change_index (
				session_id TEXT NOT NULL,
				path TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				latest_change_set_id TEXT,
				PRIMARY KEY(session_id, path)
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS change_sets (
				id TEXT PRIMARY KEY NOT NULL,
				session_id TEXT NOT NULL,
				snapshot_id TEXT,
				created_at INTEGER NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS change_set_files (
				change_set_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				path TEXT NOT NULL,
				action TEXT NOT NULL,
				before_content TEXT,
				after_content TEXT,
				snapshot_id TEXT,
				PRIMARY KEY(change_set_id, path)
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS review_entries (
				id TEXT PRIMARY KEY NOT NULL,
				path TEXT NOT NULL,
				action TEXT NOT NULL,
				before_content TEXT,
				after_content TEXT,
				snapshot_id TEXT,
				status TEXT DEFAULT 'pending' NOT NULL,
				hunk_statuses TEXT DEFAULT '[]' NOT NULL,
				latest_session_id TEXT NOT NULL,
				session_ids TEXT DEFAULT '[]' NOT NULL,
				diff_signature TEXT DEFAULT '' NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		this.ctx.storage.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS review_entries_path_idx ON review_entries (path)');
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS review_entry_sources (
				review_entry_id TEXT NOT NULL,
				change_set_id TEXT NOT NULL,
				order_index INTEGER NOT NULL,
				PRIMARY KEY(review_entry_id, change_set_id)
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS review_resolutions (
				id TEXT PRIMARY KEY NOT NULL,
				review_entry_id TEXT NOT NULL,
				decision TEXT NOT NULL,
				hunk_statuses TEXT DEFAULT '[]' NOT NULL,
				resolved_at INTEGER NOT NULL
			)
		`);
	}

	private async withProjectMount<T>(callback: () => Promise<T>, projectId = this.getProjectId()): Promise<T> {
		const filesystemId = toDurableObjectId(filesystemNamespace, projectId);
		const filesystemStub = filesystemNamespace.get(filesystemId);
		return withMounts(async () => {
			mount(PROJECT_ROOT, filesystemStub);
			return callback();
		});
	}

	// =========================================================================
	// Database Helpers
	// =========================================================================
	private buildUserMessage(
		parts: UserMessagePart[],
		mode: AgentMode,
		model: AIModelId,
		state: 'queued' | 'committed',
		authorUserId?: string,
		messageId = crypto.randomUUID(),
		createdAt = Date.now(),
	): ChatMessage {
		return {
			id: messageId,
			role: 'user',
			parts,
			authorUserId,
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
		return this.withSessionMutationLock(sessionId, async () => {
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
		});
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
			const deepLinkTarget = { kind: 'agent-session' as const, sessionId };
			env.PUSH.notifyUser(userId, {
				tag: sessionId,
				title,
				body,
				path: buildProjectDeepLinkPath(projectId, deepLinkTarget),
				deepLink: {
					projectId,
					target: deepLinkTarget,
				},
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

	private async refreshSessionPrompt(sessionId: string): Promise<void> {
		this.invalidateCachedSession(sessionId);
		await this.sessionManager
			.getSession(sessionId)
			.refreshSystemPrompt()
			.catch((error) => {
				console.error('[AgentRunner] Failed to refresh session prompt:', error);
			});
	}

	private invalidateCachedSession(sessionId: string): void {
		const sessionCache = Reflect.get(this.sessionManager, '_sessions');
		if (sessionCache instanceof Map) {
			sessionCache.delete(sessionId);
		}
	}

	private async indexArtifact(entry: SearchableArtifactEntry): Promise<void> {
		await this.artifactsProvider.set(entry.key, entry.content);
	}

	private getProjectId(): string {
		return this.name.startsWith('agent:') ? this.name.slice(6) : this.name;
	}
}
