/**
 * API Client
 *
 * Type-safe API client using Hono RPC.
 * Provides full type inference from the backend routes.
 */

import { hc } from 'hono/client';

import { serializeMessage, parseServerMessage, type ClientMessage, type ServerMessage } from '@shared/ws-messages';

import { throwApiError } from './api-error';

import type { ApiRoutes } from '@server/routes';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, AiSession, AssetSettings, PendingFileChange, ProjectTemplateMeta, UIMessage } from '@shared/types';

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
// Project Management
// =============================================================================

/**
 * Create a new project.
 *
 * Uses raw fetch because this is a root-level endpoint (`/api/new-project`)
 * outside the project-scoped RPC client.
 *
 * @param templateId - Template ID to initialize the project with.
 */
export async function createProject(templateId: string): Promise<{ projectId: string; url: string; name: string }> {
	const response = await fetch('/api/new-project', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ template: templateId }),
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to create project');
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
 * @param sourceProjectId - The ID of the project to clone
 */
export async function cloneProject(sourceProjectId: string): Promise<{ projectId: string; url: string; name: string }> {
	const response = await fetch('/api/clone-project', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sourceProjectId }),
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to clone project');
	}
	const data: { projectId: string; url: string; name: string } = await response.json();
	return data;
}

/**
 * Fetch available project templates.
 *
 * Uses raw fetch because this is a root-level endpoint (`/api/templates`)
 * outside the project-scoped RPC client.
 */
export async function fetchTemplates(): Promise<ProjectTemplateMeta[]> {
	const response = await fetch('/api/templates');
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch templates');
	}
	const data: { templates: ProjectTemplateMeta[] } = await response.json();
	return data.templates;
}

/**
 * Fetch project metadata (name, humanId, dependencies, assetSettings).
 */
export async function fetchProjectMeta(
	projectId: string,
): Promise<{ name: string; humanId: string; dependencies?: Record<string, string>; assetSettings?: AssetSettings }> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch project meta');
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
		await throwApiError(response, 'Failed to update project meta');
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
		await throwApiError(response, 'Failed to update dependencies');
	}
	return response.json();
}

/**
 * Update project asset settings.
 */
export async function updateAssetSettings(
	projectId: string,
	assetSettings: AssetSettings,
): Promise<{ name: string; humanId: string; assetSettings?: AssetSettings }> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$put({ json: { assetSettings } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to update asset settings');
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
		await throwApiError(response, 'Failed to download project');
	}
	return response.blob();
}

// =============================================================================
// Deployment
// =============================================================================

/**
 * Credentials needed to deploy to a user's Cloudflare account.
 */
export interface DeployCredentials {
	accountId: string;
	apiToken: string;
	workerName?: string;
}

/**
 * Deploy a project to the user's Cloudflare account.
 *
 * The backend collects project files, builds the multipart payload,
 * and uploads to the Cloudflare Workers API on the user's behalf.
 * The API token is used only for the duration of this request.
 */
export async function deployProject(
	projectId: string,
	credentials: DeployCredentials,
): Promise<{ success: boolean; workerName: string; workerUrl?: string }> {
	const response = await fetch(`/p/${projectId}/api/deploy`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(credentials),
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to deploy project');
	}
	return response.json();
}

// =============================================================================
// AI Session Management
// =============================================================================

/**
 * List all saved AI sessions for a project.
 */
export async function listAiSessions(projectId: string) {
	const api = createApiClient(projectId);
	const response = await api['ai-sessions'].$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to list AI sessions');
	}
	const data = await response.json();
	return data.sessions;
}

/**
 * Load a single AI session by ID.
 *
 * Uses raw fetch because the backend returns untyped `JSON.parse(raw)`,
 * which Hono RPC cannot infer as `AiSession`.
 *
 * Returns `undefined` only when the session genuinely does not exist (404).
 * Throws on transient errors (500, network failures) so callers can retry.
 */
export async function loadAiSession(projectId: string, sessionId: string): Promise<AiSession | undefined> {
	const response = await fetch(`/p/${projectId}/api/ai-session?id=${encodeURIComponent(sessionId)}`);
	if (response.status === 404) return undefined;
	if (!response.ok) {
		await throwApiError(response, 'Failed to load session');
	}
	const data: AiSession = await response.json();
	return data;
}

/**
 * Revert an AI session to a given message index (server-side truncation).
 * If messageIndex is 0, the session is deleted entirely.
 * Returns the estimated context token usage for the truncated history.
 */
export async function revertAiSession(projectId: string, sessionId: string, messageIndex: number): Promise<{ contextTokensUsed: number }> {
	const response = await fetch(`/p/${projectId}/api/ai-session/revert`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ id: sessionId, messageIndex }),
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to revert AI session');
	}
	const data: { contextTokensUsed?: number } = await response.json();
	return { contextTokensUsed: data.contextTokensUsed ?? 0 };
}

// =============================================================================
// Project-Level Pending Changes
// =============================================================================

/**
 * Load project-level pending changes from the backend.
 * Returns a Record keyed by file path, or empty object if none exist.
 */
export async function loadProjectPendingChanges(projectId: string): Promise<Record<string, PendingFileChange>> {
	const response = await fetch(`/p/${projectId}/api/pending-changes`);
	if (!response.ok) return {};
	const data: Record<string, PendingFileChange> = await response.json();
	return data;
}

/**
 * Save project-level pending changes to the backend.
 * Uses raw fetch because the Zod schema uses string keys.
 */
export async function saveProjectPendingChanges(projectId: string, changes: Record<string, PendingFileChange>): Promise<void> {
	const response = await fetch(`/p/${projectId}/api/pending-changes`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(changes),
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to save pending changes');
	}
}

// =============================================================================
// Debug Logs
// =============================================================================

/**
 * Fetch the latest debug log ID for a session.
 *
 * Returns the ID of the most recent debug log file, or undefined if none exists.
 *
 * @param projectId - The project ID
 * @param sessionId - The session ID to look up debug logs for
 */
export async function fetchLatestDebugLogId(projectId: string, sessionId: string): Promise<string | undefined> {
	const parameters = new URLSearchParams({ sessionId });
	const response = await fetch(`/p/${projectId}/api/ai/latest-debug-log-id?${parameters.toString()}`);
	if (!response.ok) return undefined;
	const data: { id: string } = await response.json();
	return data.id || undefined;
}

/**
 * Download an agent debug log as a JSON file.
 *
 * Fetches the debug log from the backend and triggers a browser file download.
 *
 * @param projectId - The project ID
 * @param logId - The debug log ID
 * @param sessionId - Optional session ID for session-scoped debug logs
 */
export async function downloadDebugLog(projectId: string, logId: string, sessionId?: string): Promise<void> {
	const parameters = new URLSearchParams({ id: logId });
	if (sessionId) {
		parameters.set('sessionId', sessionId);
	}
	const response = await fetch(`/p/${projectId}/api/ai/debug-log?${parameters.toString()}`);
	if (!response.ok) {
		await throwApiError(response, 'Failed to download debug log');
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

// =============================================================================
// AI Agent Control
// =============================================================================

/**
 * Parameters for starting an AI agent chat run.
 */
export interface StartAgentChatParameters {
	messages: UIMessage[];
	mode?: AgentMode;
	sessionId?: string;
	model?: AIModelId;
	outputLogs?: string;
}

/**
 * Start an AI agent chat run.
 *
 * The agent loop runs in the AgentRunner Durable Object independently
 * of this HTTP request. Stream events are delivered via WebSocket
 * through the ProjectCoordinator.
 *
 * @returns The session ID
 */
export async function startAgentChat(projectId: string, parameters: StartAgentChatParameters): Promise<{ sessionId: string }> {
	const response = await fetch(`/p/${projectId}/api/ai/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(parameters),
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to start agent');
	}
	return response.json();
}

/**
 * Abort a running AI agent session.
 *
 * @param projectId - The project ID
 * @param sessionId - The session to abort. If omitted, aborts ALL running sessions.
 */
export async function abortAgent(projectId: string, sessionId?: string): Promise<void> {
	const api = createApiClient(projectId);
	const response = await api.ai.abort.$post({ json: { sessionId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to abort agent');
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
