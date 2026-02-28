import { DurableObject } from 'cloudflare:workers';

import { COLLAB_COLORS } from '@shared/constants';
import { serializeMessage, parseClientMessage } from '@shared/ws-messages';

import { agentRunnerNamespace } from '../lib/durable-object-namespaces';

import type { ActiveAgentSession, HmrUpdate, Participant } from '@shared/types';
import type { ServerMessage } from '@shared/ws-messages';

/**
 * Participant attachment stored on WebSocket connections.
 */
interface ParticipantAttachment {
	id: string;
	color: string;
	file: string | null;
	cursor: { line: number; ch: number } | null;
	selection: { anchor: { line: number; ch: number }; head: { line: number; ch: number } } | null;
	joined: boolean;
}

/**
 * Storage keys used by the synchronous KV API (`ctx.storage.kv`).
 * All persisted values must be serializable via the structured clone algorithm.
 */
const STORAGE_KEY = {
	/** Last serialized server-error message (string). Replayed to late-joining clients. */
	LAST_SERVER_ERROR: 'lastServerError',
	/** Monotonic HMR version counter (number). Survives hibernation / eviction. */
	UPDATE_VERSION: 'updateVersion',
	/** Latest IDE output-logs snapshot (string). Read by the AI agent service. */
	OUTPUT_LOGS: 'outputLogs',
} as const;

/**
 * Project Coordinator Durable Object
 *
 * Manages WebSocket connections for:
 * - Hot Module Replacement (HMR) update broadcasts to preview and editor clients
 * - Real-time collaboration (cursor positions, file edits)
 * - Server error and log forwarding
 *
 * Each project has its own ProjectCoordinator instance (keyed by `project:${projectId}`).
 *
 * All durable state is persisted to the DO's SQLite-backed storage via
 * `ctx.storage.kv` so it survives hibernation and eviction. Only truly
 * transient data (pending CDP promise callbacks) is kept in-memory.
 */
export class ProjectCoordinator extends DurableObject {
	/**
	 * Pending CDP command requests awaiting a response from a frontend client.
	 *
	 * These contain `resolve` callbacks which are not serializable.
	 * If the DO is evicted while requests are pending, callers will time out
	 * on their side. When the DO wakes from hibernation, this Map starts empty,
	 * which is safe because any in-flight CDP promises will have already expired.
	 */
	private pendingCdpRequests = new Map<string, { resolve: (value: { result?: string; error?: string }) => void }>();

	// =========================================================================
	// Persisted state — native get/set backed by ctx.storage.kv
	// =========================================================================

	/** Last server-error message, replayed to newly connected clients. */
	private get lastServerError(): string | undefined {
		return this.ctx.storage.kv.get<string>(STORAGE_KEY.LAST_SERVER_ERROR);
	}

	private set lastServerError(value: string | undefined) {
		if (value === undefined) {
			this.ctx.storage.kv.delete(STORAGE_KEY.LAST_SERVER_ERROR);
		} else {
			this.ctx.storage.kv.put(STORAGE_KEY.LAST_SERVER_ERROR, value);
		}
	}

	/** Monotonically increasing version counter for HMR updates. */
	private get updateVersion(): number {
		return this.ctx.storage.kv.get<number>(STORAGE_KEY.UPDATE_VERSION) ?? 0;
	}

	private set updateVersion(value: number) {
		this.ctx.storage.kv.put(STORAGE_KEY.UPDATE_VERSION, value);
	}

	/** Latest IDE output logs snapshot pushed by the frontend. */
	private get outputLogs(): string {
		return this.ctx.storage.kv.get<string>(STORAGE_KEY.OUTPUT_LOGS) ?? '';
	}

	private set outputLogs(value: string) {
		this.ctx.storage.kv.put(STORAGE_KEY.OUTPUT_LOGS, value);
	}

	private getAttachment(ws: WebSocket): ParticipantAttachment | undefined {
		try {
			const attachment: ParticipantAttachment = ws.deserializeAttachment();
			return attachment;
		} catch {
			return undefined;
		}
	}

	private setAttachment(ws: WebSocket, data: ParticipantAttachment): void {
		ws.serializeAttachment(data);
	}

	private nextColor(): string {
		// Derive color index from current WebSocket count so it survives DO hibernation
		const currentCount = this.ctx.getWebSockets().length;
		return COLLAB_COLORS[currentCount % COLLAB_COLORS.length];
	}

	private getAllParticipants(excludeId?: string): Participant[] {
		const participants: Participant[] = [];
		for (const ws of this.ctx.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			const att = this.getAttachment(ws);
			if (att?.joined && att.id !== excludeId) {
				participants.push({
					id: att.id,
					color: att.color,
					file: att.file,
					cursor: att.cursor,
					selection: att.selection,
				});
			}
		}
		return participants;
	}

	private sendToOthersJoined(sender: WebSocket, message: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === sender || ws.readyState !== WebSocket.OPEN) continue;
			const att = this.getAttachment(ws);
			if (!att?.joined) continue;
			try {
				ws.send(message);
			} catch {
				try {
					ws.close(1011, 'send failed');
				} catch {
					// Ignore close errors
				}
			}
		}
	}

	private sendToAll(message: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			try {
				ws.send(message);
			} catch {
				try {
					ws.close(1011, 'send failed');
				} catch {
					// Ignore close errors
				}
			}
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// WebSocket upgrade
		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			const participantId = crypto.randomUUID();
			const color = this.nextColor();
			const attachment: ParticipantAttachment = {
				id: participantId,
				color,
				// eslint-disable-next-line unicorn/no-null -- Participant wire format uses null
				file: null,
				// eslint-disable-next-line unicorn/no-null -- Participant wire format uses null
				cursor: null,
				// eslint-disable-next-line unicorn/no-null -- Participant wire format uses null
				selection: null,
				joined: false,
			};

			this.ctx.acceptWebSocket(server);
			this.setAttachment(server, attachment);

			// eslint-disable-next-line unicorn/no-null -- WebSocket API requires null body
			return new Response(null, { status: 101, webSocket: client });
		}

		return new Response('Not found', { status: 404 });
	}

	// =========================================================================
	// RPC methods (called directly from other workers via stub)
	// =========================================================================

	async triggerUpdate(update: HmrUpdate): Promise<void> {
		await this.broadcastHmrUpdate(update);
	}

	async sendMessage(message: ServerMessage): Promise<void> {
		const serialized = serializeMessage(message);
		// Track last server-error so it can be replayed to late-joining clients
		if (message.type === 'server-error') {
			this.lastServerError = serialized;
		}
		this.sendToAll(serialized);
	}

	/**
	 * Send a CDP command to the preview iframe via a connected frontend client.
	 * Returns the CDP response result or an error message.
	 */
	async sendCdpCommand(id: string, method: string, parameters?: Record<string, unknown>): Promise<{ result?: string; error?: string }> {
		const openSockets = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
		if (openSockets.length === 0) {
			return { error: 'No browser is connected to the project.' };
		}

		const CDP_TIMEOUT_MS = 10_000;

		return new Promise<{ result?: string; error?: string }>((resolve) => {
			const timeout = setTimeout(() => {
				this.pendingCdpRequests.delete(id);
				resolve({ error: 'CDP command timed out. The preview iframe may not be loaded or chobitsu is not responding.' });
			}, CDP_TIMEOUT_MS);

			this.pendingCdpRequests.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					this.pendingCdpRequests.delete(id);
					resolve(value);
				},
			});

			const message = serializeMessage({
				type: 'cdp-request',
				id,
				method,
				params: parameters,
			});
			this.sendToAll(message);
		});
	}

	/**
	 * Get the latest IDE output logs snapshot.
	 * Called by the AI agent service between iterations to check for new errors/warnings.
	 */
	async getOutputLogs(): Promise<string> {
		return this.outputLogs;
	}

	/**
	 * Get the active agent session state by querying the AgentRunner DO.
	 * Used to include agent status in collab-state for late-joining clients.
	 */
	async getActiveAgentSession(): Promise<ActiveAgentSession | undefined> {
		try {
			const projectId = this.deriveProjectId();
			if (!projectId) return undefined;
			const agentRunnerId = agentRunnerNamespace.idFromName(`agent:${projectId}`);
			const agentRunnerStub = agentRunnerNamespace.get(agentRunnerId);
			return await agentRunnerStub.getAgentStatus();
		} catch {
			return undefined;
		}
	}

	/**
	 * Derive the project ID from the DO name.
	 * The coordinator is keyed as `project:${projectId}`.
	 */
	private deriveProjectId(): string | undefined {
		const name = this.ctx.id.name;
		if (!name) return undefined;
		return name.startsWith('project:') ? name.slice(8) : name;
	}

	/**
	 * Forward an agent-abort request to the AgentRunner DO.
	 */
	private async forwardAgentAbort(): Promise<void> {
		try {
			const projectId = this.deriveProjectId();
			if (!projectId) return;
			const agentRunnerId = agentRunnerNamespace.idFromName(`agent:${projectId}`);
			const agentRunnerStub = agentRunnerNamespace.get(agentRunnerId);
			await agentRunnerStub.abortAgent();
		} catch (error) {
			console.error('Failed to forward agent abort:', error);
		}
	}

	/**
	 * Send the initial collab-state message to a newly joined client.
	 * Includes the active agent session status if one is running.
	 */
	private async sendCollabState(ws: WebSocket, attachment: ParticipantAttachment): Promise<void> {
		let activeAgentSession: ActiveAgentSession | undefined;
		try {
			activeAgentSession = await this.getActiveAgentSession();
			// Only include sessions with 'running' status — completed/error/aborted
			// are stale and not useful to late joiners.
			if (activeAgentSession && activeAgentSession.status !== 'running') {
				activeAgentSession = undefined;
			}
		} catch {
			// Non-fatal — proceed without agent session info
		}

		try {
			ws.send(
				serializeMessage({
					type: 'collab-state',
					selfId: attachment.id,
					selfColor: attachment.color,
					participants: this.getAllParticipants(attachment.id),
					...(activeAgentSession ? { activeAgentSession } : {}),
				}),
			);
		} catch {
			// Ignore send errors — client may have disconnected
		}
	}

	private async broadcastHmrUpdate(update: HmrUpdate): Promise<void> {
		let updateType: 'css-update' | 'js-update' | 'full-reload';
		if (update.type === 'full-reload') {
			updateType = 'full-reload';
			// Clear stale error on successful reload
			this.lastServerError = undefined;
		} else if (update.isCSS) {
			updateType = 'css-update';
		} else {
			updateType = 'js-update';
		}

		// Increment the monotonic version counter. Clients track the latest
		// version they have seen and send it on reconnect so we can detect
		// whether they missed any updates during a reload window.
		const nextVersion = this.updateVersion + 1;
		this.updateVersion = nextVersion;

		const message = serializeMessage({
			type: update.type,
			version: nextVersion,
			updates: [
				{
					type: updateType,
					path: update.path,
					timestamp: update.timestamp,
				},
			],
		});

		this.sendToAll(message);
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		try {
			const messageString = typeof message === 'string' ? message : new TextDecoder().decode(message);
			const parsed = parseClientMessage(messageString);
			if (!parsed.success) return;
			const data = parsed.data;

			if (data.type === 'ping') {
				ws.send(serializeMessage({ type: 'pong' }));
				return;
			}

			if (data.type === 'hmr-connect') {
				// The HMR client sends its last-seen version after connecting
				// (or reconnecting post-reload). If the coordinator's version
				// is higher, the client missed one or more updates and needs
				// to reload to pick up the latest content.
				const currentVersion = this.updateVersion;
				if (data.lastVersion < currentVersion) {
					try {
						ws.send(
							serializeMessage({
								type: 'full-reload',
								version: currentVersion,
								updates: [
									{
										type: 'full-reload',
										path: '*',
										timestamp: Date.now(),
									},
								],
							}),
						);
					} catch {
						// Ignore send errors
					}
				}
				return;
			}

			if (data.type === 'collab-join') {
				const att = this.getAttachment(ws);
				if (!att) return;
				att.joined = true;
				this.setAttachment(ws, att);

				// Send initial collab state with active agent session (if any).
				// The agent status query is async, so we send the base state first
				// and include agent status if we can fetch it quickly.
				void this.sendCollabState(ws, att);

				// Replay last server-error to late-joining clients
				const lastError = this.lastServerError;
				if (lastError) {
					try {
						ws.send(lastError);
					} catch {
						// Ignore send errors
					}
				}
				this.sendToOthersJoined(
					ws,
					serializeMessage({
						type: 'participant-joined',
						participant: {
							id: att.id,
							color: att.color,
							file: att.file,
							cursor: att.cursor,
							selection: att.selection,
						},
					}),
				);
				return;
			}

			if (data.type === 'cursor-update') {
				const att = this.getAttachment(ws);
				if (!att?.joined) return;
				// eslint-disable-next-line unicorn/no-null -- Participant wire format uses null
				att.file = data.file ?? null;
				// eslint-disable-next-line unicorn/no-null -- Participant wire format uses null
				att.cursor = data.cursor ?? null;
				// eslint-disable-next-line unicorn/no-null -- Participant wire format uses null
				att.selection = data.selection ?? null;
				this.setAttachment(ws, att);
				this.sendToOthersJoined(
					ws,
					serializeMessage({
						type: 'cursor-updated',
						id: att.id,
						color: att.color,
						file: att.file,
						cursor: att.cursor,
						selection: att.selection,
					}),
				);
				return;
			}

			if (data.type === 'file-edit') {
				const att = this.getAttachment(ws);
				if (!att?.joined) return;
				this.sendToOthersJoined(
					ws,
					serializeMessage({
						type: 'file-edited',
						id: att.id,
						path: data.path,
						content: data.content,
					}),
				);
				return;
			}

			if (data.type === 'cdp-response') {
				const pending = this.pendingCdpRequests.get(data.id);
				if (pending) {
					pending.resolve({ result: data.result, error: data.error });
				}
				return;
			}

			if (data.type === 'output-logs-sync') {
				this.outputLogs = data.logs;
				return;
			}

			if (data.type === 'agent-abort') {
				// Forward the abort to the AgentRunner DO
				void this.forwardAgentAbort();
				return;
			}
		} catch {
			// Ignore parse errors
		}
	}

	webSocketClose(ws: WebSocket, code: number, reason: string): void {
		const att = this.getAttachment(ws);
		if (att?.joined) {
			this.sendToOthersJoined(
				ws,
				serializeMessage({
					type: 'participant-left',
					id: att.id,
				}),
			);
		}
		try {
			ws.close(code, reason);
		} catch {
			// Ignore close errors
		}
	}

	webSocketError(ws: WebSocket): void {
		const att = this.getAttachment(ws);
		if (att?.joined) {
			this.sendToOthersJoined(
				ws,
				serializeMessage({
					type: 'participant-left',
					id: att.id,
				}),
			);
		}
		try {
			ws.close(1011, 'WebSocket error');
		} catch {
			// Ignore close errors
		}
	}
}
