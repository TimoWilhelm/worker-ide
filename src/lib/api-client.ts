/**
 * API Client
 *
 * Type-safe API client using Hono RPC.
 * Provides full type inference from the backend routes.
 */

import { hc } from 'hono/client';

import type { ApiRoutes } from '@server/routes';
import type { ServerMessage } from '@shared/ws-messages';

/**
 * Create a typed API client for a specific project.
 *
 * @param projectId - The project ID to scope requests to
 * @returns Typed Hono RPC client
 */
export function createApiClient(projectId: string) {
	const baseUrl = `/p/${projectId}`;
	return hc<ApiRoutes>(`${baseUrl}/api`);
}

/**
 * API client type for use in components.
 */
export type ApiClient = ReturnType<typeof createApiClient>;

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Extract the response type from an API endpoint.
 */
export type ApiResponse<T> = T extends Promise<infer R> ? R : never;

/**
 * Extract the JSON response type from a fetch response.
 */
export type JsonResponse<T> = T extends { json(): Promise<infer R> } ? R : never;

// =============================================================================
// Direct API Functions (for non-Hono endpoints)
// =============================================================================

/**
 * Create a new project.
 */
export async function createProject(): Promise<{ projectId: string; url: string; name: string }> {
	const response = await fetch('/api/new-project', { method: 'POST' });
	if (!response.ok) {
		throw new Error('Failed to create project');
	}
	const data: { projectId: string; url: string; name: string } = await response.json();
	return data;
}

/**
 * Fetch project metadata (name, humanId).
 */
export async function fetchProjectMeta(projectId: string): Promise<{ name: string; humanId: string }> {
	const response = await fetch(`/p/${projectId}/api/project/meta`);
	if (!response.ok) {
		throw new Error('Failed to fetch project meta');
	}
	return response.json();
}

/**
 * Update project name.
 */
export async function updateProjectMeta(projectId: string, name: string): Promise<{ name: string; humanId: string }> {
	const response = await fetch(`/p/${projectId}/api/project/meta`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	if (!response.ok) {
		throw new Error('Failed to update project meta');
	}
	return response.json();
}

/**
 * Download project as ZIP file.
 */
export async function downloadProject(projectId: string): Promise<Blob> {
	const response = await fetch(`/p/${projectId}/api/download`);
	if (!response.ok) {
		throw new Error('Failed to download project');
	}
	return response.blob();
}

// =============================================================================
// AI Chat Stream
// =============================================================================

export interface AIChatMessage {
	role: 'user' | 'assistant';
	content: unknown;
}

export interface AIStreamEvent {
	type: string;
	[key: string]: unknown;
}

/**
 * Start an AI chat session with streaming response.
 *
 * @param projectId - The project ID
 * @param message - User message
 * @param history - Previous conversation history
 * @param signal - AbortController signal for cancellation
 * @param onEvent - Callback for each SSE event
 */
export async function startAIChat(
	projectId: string,
	message: string,
	history: AIChatMessage[],
	signal: AbortSignal,
	onEvent: (event: AIStreamEvent) => void,
): Promise<void> {
	const response = await fetch(`/p/${projectId}/api/ai/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ message, history }),
		signal,
	});

	if (!response.ok) {
		const errorData: { error?: string } = await response.json().catch(() => ({ error: 'Unknown error' }));
		throw new Error(errorData.error || 'AI chat request failed');
	}

	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('No response body');
	}

	const decoder = new TextDecoder();
	let buffer = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			// Parse SSE events
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (line.startsWith('data: ')) {
					try {
						const event: AIStreamEvent = JSON.parse(line.slice(6));
						onEvent(event);
					} catch {
						console.warn('Failed to parse SSE event:', line);
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

// =============================================================================
// WebSocket HMR Connection
// =============================================================================

/**
 * Create a WebSocket connection for HMR updates.
 *
 * Returns a cleanup function that prevents the onClose callback from firing
 * (intentional disconnect vs unexpected drop).
 *
 * @param projectId - The project ID
 * @param onMessage - Callback for each validated ServerMessage
 * @param onClose - Callback when connection drops unexpectedly
 * @param onOpen - Callback when connection opens
 * @returns Cleanup function
 */
export interface HMRConnection {
	cleanup: () => void;
	send: (data: Record<string, unknown>) => void;
}

export function connectHMR(
	projectId: string,
	onMessage: (message: ServerMessage) => void,
	onClose?: () => void,
	onOpen?: () => void,
): HMRConnection {
	const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const wsUrl = `${protocol}//${globalThis.location.host}/p/${projectId}/__hmr`;

	let intentionalClose = false;
	const socket = new WebSocket(wsUrl);

	socket.addEventListener('open', () => {
		// Send collab-join immediately on connection (matching old behaviour)
		socket.send(JSON.stringify({ type: 'collab-join' }));
		onOpen?.();
	});

	socket.addEventListener('message', (event) => {
		try {
			const parsed: ServerMessage = JSON.parse(String(event.data));
			onMessage(parsed);
		} catch {
			console.warn('Failed to parse HMR message:', event.data);
		}
	});

	socket.addEventListener('close', () => {
		// Only fire onClose for unexpected disconnects
		if (!intentionalClose) {
			onClose?.();
		}
	});

	socket.addEventListener('error', () => {
		// Error events are always followed by close events, so we don't need
		// to do anything special here — just let the close handler fire.
	});

	// Keep connection alive
	const pingInterval = setInterval(() => {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'ping' }));
		}
	}, 30_000);

	const send = (data: Record<string, unknown>) => {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(data));
		}
	};

	// Return connection object with cleanup and send functions
	return {
		cleanup: () => {
			intentionalClose = true;
			clearInterval(pingInterval);
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close(1000, 'cleanup');
			}
		},
		send,
	};
}
