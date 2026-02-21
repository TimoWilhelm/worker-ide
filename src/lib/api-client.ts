/**
 * API Client
 *
 * Type-safe API client using Hono RPC.
 * Provides full type inference from the backend routes.
 */

import { hc } from 'hono/client';

import { serializeMessage, parseServerMessage, type ClientMessage, type ServerMessage } from '@shared/ws-messages';

import type { ApiRoutes } from '@server/routes';
import type { AiSession } from '@shared/types';

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
// Project Management
// =============================================================================

/**
 * Create a new project.
 *
 * Uses raw fetch because this is a root-level endpoint (`/api/new-project`)
 * outside the project-scoped RPC client.
 *
 * @param templateId - Optional template ID to initialize the project with.
 *                     Defaults to 'request-inspector' on the server if omitted.
 */
export async function createProject(templateId?: string): Promise<{ projectId: string; url: string; name: string }> {
	const body = templateId ? JSON.stringify({ template: templateId }) : undefined;
	const headers: Record<string, string> = {};
	if (body) {
		headers['Content-Type'] = 'application/json';
	}
	const response = await fetch('/api/new-project', { method: 'POST', body, headers });
	if (!response.ok) {
		throw new Error('Failed to create project');
	}
	const data: { projectId: string; url: string; name: string } = await response.json();
	return data;
}

/**
 * Clone an existing project by ID.
 *
 * Creates a new project with all files copied from the source project.
 * The clone runs server-side; this function waits for it to complete.
 * Typical projects clone in under 2 seconds.
 *
 * @param sourceProjectId - The 64-character hex ID of the project to clone
 */
export async function cloneProject(sourceProjectId: string): Promise<{ projectId: string; url: string; name: string }> {
	const response = await fetch('/api/clone-project', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sourceProjectId }),
	});
	if (!response.ok) {
		const errorData: { error?: string } = await response.json().catch(() => ({ error: 'Clone failed' }));
		throw new Error(errorData.error || 'Failed to clone project');
	}
	const data: { projectId: string; url: string; name: string } = await response.json();
	return data;
}

/**
 * Fetch project metadata (name, humanId, dependencies).
 */
export async function fetchProjectMeta(
	projectId: string,
): Promise<{ name: string; humanId: string; dependencies?: Record<string, string> }> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$get({});
	if (!response.ok) {
		throw new Error('Failed to fetch project meta');
	}
	return response.json();
}

/**
 * Update project name.
 */
export async function updateProjectMeta(projectId: string, name: string): Promise<{ name: string; humanId: string }> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$put({ json: { name } });
	if (!response.ok) {
		throw new Error('Failed to update project meta');
	}
	return response.json();
}

/**
 * Update project dependencies.
 */
export async function updateDependencies(
	projectId: string,
	dependencies: Record<string, string>,
): Promise<{ name: string; humanId: string; dependencies?: Record<string, string> }> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$put({ json: { dependencies } });
	if (!response.ok) {
		throw new Error('Failed to update dependencies');
	}
	return response.json();
}

/**
 * Download project as a deployable ZIP file.
 *
 * Uses raw fetch because the response is a binary blob, not typed JSON.
 */
export async function downloadProject(projectId: string): Promise<Blob> {
	const response = await fetch(`/p/${projectId}/api/download`);
	if (!response.ok) {
		throw new Error('Failed to download project');
	}
	return response.blob();
}

// =============================================================================
// AI Session Management
// =============================================================================

/**
 * List all saved AI sessions for a project.
 */
export async function listAiSessions(projectId: string): Promise<Array<{ id: string; label: string; createdAt: number }>> {
	const api = createApiClient(projectId);
	const response = await api['ai-sessions'].$get({});
	if (!response.ok) {
		throw new Error('Failed to list AI sessions');
	}
	const data: { sessions: Array<{ id: string; label: string; createdAt: number }> } = await response.json();
	return data.sessions;
}

/**
 * Load a single AI session by ID.
 *
 * Uses raw fetch because the backend returns untyped `JSON.parse(raw)`,
 * which Hono RPC cannot infer as `AiSession`.
 */
export async function loadAiSession(projectId: string, sessionId: string): Promise<AiSession | undefined> {
	const response = await fetch(`/p/${projectId}/api/ai-session?id=${encodeURIComponent(sessionId)}`);
	if (!response.ok) return undefined;
	const data: AiSession = await response.json();
	return data;
}

/**
 * Save an AI session to the backend.
 *
 * Uses raw fetch because the Zod schema uses `z.unknown()` for history,
 * causing a type mismatch with the `AiSession` interface.
 */
export async function saveAiSession(projectId: string, session: AiSession): Promise<void> {
	const response = await fetch(`/p/${projectId}/api/ai-session`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(session),
	});
	if (!response.ok) {
		throw new Error('Failed to save AI session');
	}
}

// =============================================================================
// Debug Logs
// =============================================================================

/**
 * Download an agent debug log as a JSON file.
 *
 * Fetches the debug log from the backend and triggers a browser file download.
 */
export async function downloadDebugLog(projectId: string, logId: string): Promise<void> {
	const response = await fetch(`/p/${projectId}/api/ai/debug-log?id=${encodeURIComponent(logId)}`);
	if (!response.ok) {
		throw new Error('Failed to download debug log');
	}
	const data: unknown = await response.json();
	const blob = new Blob([JSON.stringify(data, undefined, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = `agent-debug-log-${logId}.json`;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/**
 * Fetch the most recent debug log ID for a project.
 *
 * Used to retrieve the debug log ID when the SSE stream is interrupted
 * (user cancel or network error) before the backend can send the debug_log event.
 */
export async function fetchLatestDebugLogId(projectId: string): Promise<string | undefined> {
	try {
		const response = await fetch(`/p/${projectId}/api/ai/debug-log/latest`);
		if (!response.ok) return undefined;
		const data: { id?: string } = await response.json();
		return data.id;
	} catch {
		return undefined;
	}
}

// =============================================================================
// WebSocket Connection
// =============================================================================

/**
 * Create a WebSocket connection for project coordination.
 *
 * Handles HMR update notifications, real-time collaboration,
 * server error/log forwarding, and file edit broadcasts.
 *
 * Returns a cleanup function that prevents the onClose callback from firing
 * (intentional disconnect vs unexpected drop).
 */
export interface ProjectSocketConnection {
	cleanup: () => void;
	send: (data: ClientMessage) => void;
}

export function connectProjectSocket(
	projectId: string,
	onMessage: (message: ServerMessage) => void,
	onClose?: () => void,
	onOpen?: () => void,
): ProjectSocketConnection {
	const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const wsUrl = `${protocol}//${globalThis.location.host}/p/${projectId}/__ws`;

	let intentionalClose = false;
	const socket = new WebSocket(wsUrl);

	socket.addEventListener('open', () => {
		// Send collab-join immediately on connection (matching old behaviour)
		socket.send(serializeMessage({ type: 'collab-join' }));
		onOpen?.();
	});

	socket.addEventListener('message', (event) => {
		const result = parseServerMessage(String(event.data));
		if (result.success) {
			onMessage(result.data);
		} else {
			console.warn('Failed to parse WebSocket message:', result.error);
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
			socket.send(serializeMessage({ type: 'ping' }));
		}
	}, 30_000);

	const send = (data: ClientMessage) => {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(serializeMessage(data));
		}
	};

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
