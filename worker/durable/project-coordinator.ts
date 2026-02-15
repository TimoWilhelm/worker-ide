import { DurableObject } from 'cloudflare:workers';

import { COLLAB_COLORS } from '@shared/constants';
import { serializeMessage, parseClientMessage } from '@shared/ws-messages';

import type { HmrUpdate, Participant } from '@shared/types';

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
 * Project Coordinator Durable Object
 *
 * Manages WebSocket connections for:
 * - Hot Module Replacement (HMR) update broadcasts to preview and editor clients
 * - Real-time collaboration (cursor positions, file edits)
 * - Server error and log forwarding
 *
 * Each project has its own ProjectCoordinator instance (keyed by `project:${projectId}`).
 */
export class ProjectCoordinator extends DurableObject {
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
			if (ws === sender) continue;
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

		// Trigger HMR update from internal request
		if (url.pathname === '/ws/trigger' && request.method === 'POST') {
			const update: HmrUpdate = await request.json();
			await this.broadcast(update);
			return Response.json(
				{ success: true },
				{
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Send arbitrary message to all clients
		if (url.pathname === '/ws/send' && request.method === 'POST') {
			const message = await request.text();
			this.sendToAll(message);
			return Response.json(
				{ success: true },
				{
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		return new Response('Not found', { status: 404 });
	}

	async broadcast(update: HmrUpdate): Promise<void> {
		let updateType: 'css-update' | 'js-update' | 'full-reload';
		if (update.type === 'full-reload') {
			updateType = 'full-reload';
		} else if (update.isCSS) {
			updateType = 'css-update';
		} else {
			updateType = 'js-update';
		}

		const message = serializeMessage({
			type: update.type,
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

			if (data.type === 'collab-join') {
				const att = this.getAttachment(ws);
				if (!att) return;
				att.joined = true;
				this.setAttachment(ws, att);
				ws.send(
					serializeMessage({
						type: 'collab-state',
						selfId: att.id,
						selfColor: att.color,
						participants: this.getAllParticipants(att.id),
					}),
				);
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
