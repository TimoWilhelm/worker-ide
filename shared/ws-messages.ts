/**
 * WebSocket message types and serialization for real-time features.
 *
 * Used by two independent WebSocket connections:
 * 1. **Preview HMR client** (`hmr-client.js`) — handles hot module replacement
 *    in the preview iframe (full-reload, CSS/JS hot-swap).
 * 2. **Project socket** (`use-project-socket.ts`) — handles editor-side
 *    coordination (file cache invalidation, collaboration, server events).
 *
 * Both connect to the same ProjectCoordinator Durable Object.
 */

import { z } from 'zod';

import type { CursorPosition, Participant, SelectionRange, ServerError, ServerLogEntry } from './types';

// =============================================================================
// Client -> Server Messages
// =============================================================================

/**
 * Client message for pinging the server
 */
export interface PingMessage {
	type: 'ping';
}

/**
 * Client message to join collaboration session
 */
export interface CollabJoinMessage {
	type: 'collab-join';
}

/**
 * Client message to update cursor position
 */
export interface CursorUpdateMessage {
	type: 'cursor-update';
	file: string | null;
	cursor: CursorPosition | null;
	selection: SelectionRange | null;
}

/**
 * Client message for file edit broadcast
 */
export interface FileEditMessage {
	type: 'file-edit';
	path: string;
	content: string;
}

export type ClientMessage = PingMessage | CollabJoinMessage | CursorUpdateMessage | FileEditMessage;

// =============================================================================
// Server -> Client Messages
// =============================================================================

/**
 * Server pong response
 */
export interface PongMessage {
	type: 'pong';
}

/**
 * Server message with initial collaboration state
 */
export interface CollabStateMessage {
	type: 'collab-state';
	selfId: string;
	selfColor: string;
	participants: Participant[];
}

/**
 * Server message when a participant joins
 */
export interface ParticipantJoinedMessage {
	type: 'participant-joined';
	participant: Participant;
}

/**
 * Server message when a participant leaves
 */
export interface ParticipantLeftMessage {
	type: 'participant-left';
	id: string;
}

/**
 * Server message when a cursor is updated
 */
export interface CursorUpdatedMessage {
	type: 'cursor-updated';
	id: string;
	color: string;
	file: string | null;
	cursor: CursorPosition | null;
	selection: SelectionRange | null;
}

/**
 * Server message when a file is edited by another participant
 */
export interface FileEditedMessage {
	type: 'file-edited';
	id: string;
	path: string;
	content: string;
}

/**
 * HMR update types
 */
export type HmrUpdateType = 'css-update' | 'js-update' | 'full-reload';

/**
 * HMR update message
 */
export interface HmrUpdateMessage {
	type: 'update' | 'full-reload';
	updates: Array<{
		type: HmrUpdateType;
		path: string;
		timestamp: number;
	}>;
}

/**
 * Server error message
 */
export interface ServerErrorMessage {
	type: 'server-error';
	error: ServerError;
}

/**
 * Server logs message
 */
export interface ServerLogsMessage {
	type: 'server-logs';
	logs: ServerLogEntry[];
}

export type ServerMessage =
	| PongMessage
	| CollabStateMessage
	| ParticipantJoinedMessage
	| ParticipantLeftMessage
	| CursorUpdatedMessage
	| FileEditedMessage
	| HmrUpdateMessage
	| ServerErrorMessage
	| ServerLogsMessage;

// =============================================================================
// Zod Schemas for Validation
// =============================================================================

const cursorPositionSchema = z.object({
	line: z.number(),
	ch: z.number(),
});

const selectionRangeSchema = z.object({
	anchor: cursorPositionSchema,
	head: cursorPositionSchema,
});

// Client message schemas
export const clientMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ping') }),
	z.object({ type: z.literal('collab-join') }),
	z.object({
		type: z.literal('cursor-update'),
		file: z.string().nullable(),
		cursor: cursorPositionSchema.nullable(),
		selection: selectionRangeSchema.nullable(),
	}),
	z.object({
		type: z.literal('file-edit'),
		path: z.string(),
		content: z.string(),
	}),
]);

// Server message schemas (for client-side validation)
const participantSchema = z.object({
	id: z.string(),
	color: z.string(),
	file: z.string().nullable(),
	cursor: cursorPositionSchema.nullable(),
	selection: selectionRangeSchema.nullable(),
});

const dependencyErrorSchema = z.object({
	packageName: z.string(),
	code: z.enum(['unregistered', 'not-found', 'resolve-failed']),
	message: z.string(),
});

const serverErrorSchema = z.object({
	timestamp: z.number(),
	type: z.enum(['bundle', 'runtime']),
	message: z.string(),
	file: z.string().optional(),
	line: z.number().optional(),
	column: z.number().optional(),
	dependencyErrors: z.array(dependencyErrorSchema).optional(),
});

const serverLogSchema = z.object({
	type: z.literal('server-log'),
	timestamp: z.number(),
	level: z.enum(['log', 'warn', 'error', 'debug', 'info']),
	message: z.string(),
});

const hmrUpdateSchema = z.object({
	type: z.enum(['css-update', 'js-update', 'full-reload']),
	path: z.string(),
	timestamp: z.number(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('pong') }),
	z.object({
		type: z.literal('collab-state'),
		selfId: z.string(),
		selfColor: z.string(),
		participants: z.array(participantSchema),
	}),
	z.object({
		type: z.literal('participant-joined'),
		participant: participantSchema,
	}),
	z.object({
		type: z.literal('participant-left'),
		id: z.string(),
	}),
	z.object({
		type: z.literal('cursor-updated'),
		id: z.string(),
		color: z.string(),
		file: z.string().nullable(),
		cursor: cursorPositionSchema.nullable(),
		selection: selectionRangeSchema.nullable(),
	}),
	z.object({
		type: z.literal('file-edited'),
		id: z.string(),
		path: z.string(),
		content: z.string(),
	}),
	z.object({
		type: z.literal('update'),
		updates: z.array(hmrUpdateSchema),
	}),
	z.object({
		type: z.literal('full-reload'),
		updates: z.array(hmrUpdateSchema),
	}),
	z.object({
		type: z.literal('server-error'),
		error: serverErrorSchema,
	}),
	z.object({
		type: z.literal('server-logs'),
		logs: z.array(serverLogSchema),
	}),
]);

// =============================================================================
// Serialization Helpers
// =============================================================================

/**
 * Serialize a message for sending over WebSocket
 */
export function serializeMessage(message: ClientMessage | ServerMessage): string {
	return JSON.stringify(message);
}

/**
 * Parse and validate a client message
 */
export function parseClientMessage(data: string): { success: true; data: ClientMessage } | { success: false; error: string } {
	try {
		const parsed: unknown = JSON.parse(data);
		const result = clientMessageSchema.safeParse(parsed);

		if (!result.success) {
			return {
				success: false,
				error: result.error.issues.map((issue) => issue.message).join(', '),
			};
		}

		return { success: true, data: result.data };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Failed to parse message',
		};
	}
}

/**
 * Parse and validate a server message
 */
export function parseServerMessage(data: string): { success: true; data: ServerMessage } | { success: false; error: string } {
	try {
		const parsed: unknown = JSON.parse(data);
		const result = serverMessageSchema.safeParse(parsed);

		if (!result.success) {
			return {
				success: false,
				error: result.error.issues.map((issue) => issue.message).join(', '),
			};
		}

		return { success: true, data: result.data };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Failed to parse message',
		};
	}
}
