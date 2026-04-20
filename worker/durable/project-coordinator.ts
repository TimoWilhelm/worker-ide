import { DurableObject } from 'cloudflare:workers';

import { COLLAB_COLORS, MAX_CONCURRENT_COLLABORATORS } from '@shared/constants';
import { serializeMessage, parseClientMessage } from '@shared/ws-messages';

import { trackWebSocketEvent } from '../lib/analytics';

import type { HmrUpdate, Participant } from '@shared/types';
import type { ServerMessage } from '@shared/ws-messages';
type ProjectSocketClientKind = 'ide' | 'preview';

interface ParticipantAttachment {
	id: string;
	color: string;
	kind: ProjectSocketClientKind;
	file?: string;
	cursor?: { line: number; ch: number };
	selection?: { anchor: { line: number; ch: number }; head: { line: number; ch: number } };
	joined: boolean;
}

/**
 * Storage keys used by the synchronous KV API (`ctx.storage.kv`).
 * All persisted values must be serializable via the structured clone algorithm.
 */
const STORAGE_KEY = {
	LAST_SERVER_ERROR: 'lastServerError',
	UPDATE_VERSION: 'updateVersion',
	OUTPUT_LOGS: 'outputLogs',
	RECENT_FILE_EDITS: 'recentFileEdits',
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
 * `ctx.storage.kv` so it survives hibernation and eviction.
 */
export class ProjectCoordinatorV2 extends DurableObject {
	constructor(state: DurableObjectState, environment: Env) {
		super(state, environment);
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}
	private projectId: string | undefined;
	private static readonly MAX_RECENT_FILE_EDITS = 100;

	// =========================================================================
	// Persisted state — native get/set backed by ctx.storage.kv
	// =========================================================================
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
	private get updateVersion(): number {
		return this.ctx.storage.kv.get<number>(STORAGE_KEY.UPDATE_VERSION) ?? 0;
	}

	private set updateVersion(value: number) {
		this.ctx.storage.kv.put(STORAGE_KEY.UPDATE_VERSION, value);
	}
	private get outputLogs(): string {
		return this.ctx.storage.kv.get<string>(STORAGE_KEY.OUTPUT_LOGS) ?? '';
	}

	private set outputLogs(value: string) {
		this.ctx.storage.kv.put(STORAGE_KEY.OUTPUT_LOGS, value);
	}
	private get recentFileEdits(): Array<{ path: string; timestamp: number }> {
		return this.ctx.storage.kv.get<Array<{ path: string; timestamp: number }>>(STORAGE_KEY.RECENT_FILE_EDITS) ?? [];
	}

	private set recentFileEdits(value: Array<{ path: string; timestamp: number }>) {
		if (value.length === 0) {
			this.ctx.storage.kv.delete(STORAGE_KEY.RECENT_FILE_EDITS);
		} else {
			this.ctx.storage.kv.put(STORAGE_KEY.RECENT_FILE_EDITS, value);
		}
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
			if (att?.kind === 'ide' && att.joined && att.id !== excludeId) {
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
			if (!att?.joined || att.kind !== 'ide') continue;
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

	private sendToKind(kind: ProjectSocketClientKind, message: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			const att = this.getAttachment(ws);
			if (!att || att.kind !== kind) continue;
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

		// Capture the project ID forwarded by the main Worker for analytics
		const headerProjectId = request.headers.get('x-project-id');
		if (headerProjectId) {
			this.projectId = headerProjectId;
		}

		// WebSocket upgrade
		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const clientKind = request.headers.get('x-worker-ide-client-kind') === 'preview' ? 'preview' : 'ide';
			// Enforce concurrent collaborator limit
			const openSockets = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
			const openIdeSockets = openSockets.filter((ws) => this.getAttachment(ws)?.kind === 'ide');
			if (clientKind === 'ide' && openIdeSockets.length >= MAX_CONCURRENT_COLLABORATORS) {
				return new Response('Too many collaborators', { status: 429 });
			}

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			const participantId = crypto.randomUUID();
			const color = this.nextColor();
			const attachment: ParticipantAttachment = {
				id: participantId,
				color,
				kind: clientKind,
				joined: false,
			};

			this.ctx.acceptWebSocket(server);
			this.setAttachment(server, attachment);

			trackWebSocketEvent({
				projectId: this.projectId ?? this.ctx.id.toString(),
				eventType: 'connect',
				connectionType: 'coordinator',
				concurrentConnections: openSockets.length + 1,
			});

			return new Response(undefined, { status: 101, webSocket: client });
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
			this.sendToAll(serialized);
			return;
		}
		this.sendToKind('ide', serialized);
	}

	/**
	 * Get the latest IDE output logs snapshot.
	 * Called by the AI agent service between iterations to check for new errors/warnings.
	 */
	async getOutputLogs(): Promise<string> {
		return this.outputLogs;
	}

	/**
	 * Drain recent file edits made by connected users.
	 * Called by the AI agent service between iterations to detect concurrent
	 * user changes. Returns deduplicated paths and clears the buffer.
	 */
	async getRecentFileEdits(): Promise<Array<{ path: string; timestamp: number }>> {
		const edits = this.recentFileEdits;
		if (edits.length === 0) return [];
		this.recentFileEdits = [];
		// Deduplicate by path, keeping the latest timestamp per path
		const byPath = new Map<string, number>();
		for (const edit of edits) {
			const existing = byPath.get(edit.path);
			if (existing === undefined || edit.timestamp > existing) {
				byPath.set(edit.path, edit.timestamp);
			}
		}
		return [...byPath.entries()].map(([path, timestamp]) => ({ path, timestamp }));
	}
	private sendCollabState(ws: WebSocket, attachment: ParticipantAttachment): void {
		try {
			ws.send(
				serializeMessage({
					type: 'collab-state',
					selfId: attachment.id,
					selfColor: attachment.color,
					participants: this.getAllParticipants(attachment.id),
				}),
			);
		} catch {
			// Ignore send errors — client may have disconnected
		}
	}

	private async broadcastHmrUpdate(update: HmrUpdate): Promise<void> {
		// Clear stale error on any successful preview update or full reload.
		// A successful file write means the previous error may no longer apply.
		if (this.lastServerError !== undefined) {
			this.lastServerError = undefined;
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
					type: update.type,
					path: update.path,
					timestamp: update.timestamp,
					targets: update.targets,
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
			const att = this.getAttachment(ws);
			if (!att) return;

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
										targets: [],
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
				if (att.kind !== 'ide') {
					try {
						ws.close(1008, 'Forbidden');
					} catch {
						// Ignore close errors
					}
					return;
				}
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
				if (att.kind !== 'ide') return;
				if (!att?.joined) return;
				att.file = data.file;
				att.cursor = data.cursor;
				att.selection = data.selection;
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
				if (att.kind !== 'ide') return;
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
				// Track the edit so the AI agent can be notified between iterations
				const edits = this.recentFileEdits;
				edits.push({ path: data.path, timestamp: Date.now() });
				// Cap to prevent unbounded growth
				if (edits.length > ProjectCoordinatorV2.MAX_RECENT_FILE_EDITS) {
					edits.splice(0, edits.length - ProjectCoordinatorV2.MAX_RECENT_FILE_EDITS);
				}
				this.recentFileEdits = edits;
				return;
			}

			if (data.type === 'output-logs-sync') {
				if (att.kind !== 'ide') return;
				this.outputLogs = data.logs;
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

		const remainingConnections = this.ctx.getWebSockets().filter((s) => s !== ws && s.readyState === WebSocket.OPEN).length;

		trackWebSocketEvent({
			projectId: this.projectId ?? this.ctx.id.toString(),
			eventType: 'disconnect',
			connectionType: 'coordinator',
			concurrentConnections: remainingConnections,
		});

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
