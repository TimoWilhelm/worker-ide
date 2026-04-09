/**
 * API Client
 *
 * Type-safe API client using Hono RPC.
 * Provides full type inference from the backend routes.
 */

import { hc } from 'hono/client';

import { serializeMessage, parseServerMessage, type ClientMessage, type ServerMessage } from '@shared/ws-messages';

import { throwApiError } from './api-error';

import type { ApiRoutes, OrgRoutes, TransferRoutes, UserRoutes } from '@server/routes';
import type { AssetSettings, BindingsConfig, ProjectTemplateMeta } from '@shared/types';

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

/**
 * Create a typed API client for user-scoped routes (not project-scoped).
 *
 * User routes (push subscriptions, notification preferences, etc.) are
 * mounted at `/api/user/*` on the root app, outside the project-scoped
 * RPC client.
 */
export function createUserApiClient() {
	return hc<UserRoutes>('/api');
}

/**
 * Create a typed API client for organization-scoped routes.
 */
export function createOrgApiClient() {
	return hc<OrgRoutes>('/api');
}

/**
 * Create a typed API client for transfer routes.
 */
export function createTransferApiClient() {
	return hc<TransferRoutes>('/api');
}

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
export async function createProject(organizationId: string, templateId: string): Promise<{ projectId: string; url: string; name: string }> {
	const response = await fetch('/api/new-project', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ template: templateId, organizationId }),
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
export async function cloneProject(
	organizationId: string,
	sourceProjectId: string,
): Promise<{ projectId: string; url: string; name: string }> {
	const response = await fetch('/api/clone-project', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sourceProjectId, organizationId }),
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
 * Fetch projects for the active organization.
 *
 * Uses the organization-scoped RPC client for type-safe access to
 * `GET /api/org/:orgId/projects`.
 */
export async function fetchOrgProjects(organizationId: string) {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].projects.$get({ param: { orgId: organizationId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch organization projects');
	}
	const data = await response.json();
	return data.projects;
}

/**
 * Org project entry inferred from the RPC response.
 */
export type OrgProject = Awaited<ReturnType<typeof fetchOrgProjects>>[number];

/**
 * Soft-delete a project (30-day retention).
 *
 * Uses raw fetch because this is a root-level endpoint (`/api/org/project/:id`)
 * outside the project-scoped RPC client.
 */
export async function deleteProject(organizationId: string, projectId: string): Promise<void> {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].project[':projectId'].$delete({ param: { orgId: organizationId, projectId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to delete project');
	}
}

/**
 * Fetch project metadata (name, humanId, assetSettings, bindingsConfig).
 */
export async function fetchProjectMeta(
	projectId: string,
): Promise<{ name: string; humanId: string; assetSettings?: AssetSettings; bindingsConfig?: BindingsConfig }> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch project meta');
	}
	return response.json();
}

/**
 * Fetch project dependencies from package.json.
 */
export async function fetchDependencies(projectId: string): Promise<Record<string, string>> {
	const api = createApiClient(projectId);
	const response = await api.dependencies.$get({});
	if (!response.ok) {
		throw new Error('Failed to fetch dependencies');
	}
	const data = await response.json();
	return data.dependencies;
}

/**
 * Update project metadata (name, asset settings, bindings config).
 * Sends a single PUT request with all provided fields.
 */
export async function updateProjectMeta(
	projectId: string,
	meta: { name?: string; assetSettings?: AssetSettings; bindingsConfig?: BindingsConfig },
): Promise<{ name: string; humanId: string; assetSettings?: AssetSettings; bindingsConfig?: BindingsConfig }> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$put({ json: meta });
	if (!response.ok) {
		await throwApiError(response, 'Failed to update project meta');
	}
	return response.json();
}

/**
 * Fetch storage usage and quota for a project.
 */
export async function fetchStorageUsage(projectId: string): Promise<{ usageBytes: number; quotaBytes: number; enabled: boolean }> {
	const api = createApiClient(projectId);
	const response = await api.project.storage.$get({});
	if (!response.ok) {
		throw new Error('Failed to fetch storage usage');
	}
	return response.json();
}

/**
 * Update project dependencies in package.json.
 */
export async function updateDependencies(projectId: string, dependencies: Record<string, string>): Promise<Record<string, string>> {
	const api = createApiClient(projectId);
	const response = await api.dependencies.$put({ json: { dependencies } });
	if (!response.ok) {
		throw new Error('Failed to update dependencies');
	}
	const data = await response.json();
	return data.dependencies;
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
// Limits
// =============================================================================

/**
 * Resolved org limits with current usage.
 */
export interface OrgLimits {
	maxProjects: number;
	currentProjects: number;
	maxMembers: number;
	currentMembers: number;
}

/**
 * Resolved user limits with current usage.
 */
export interface UserLimits {
	maxOrganizations: number;
	currentOrganizations: number;
}

/**
 * Fetch resolved limits + current usage for an organization.
 * Limits reflect the org's plan defaults with any entitlement overrides applied.
 */
export async function fetchOrgLimits(organizationId: string): Promise<OrgLimits> {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].limits.$get({ param: { orgId: organizationId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch organization limits');
	}
	return response.json();
}

/**
 * Fetch resolved limits + current usage for the authenticated user.
 * Limits reflect defaults with any entitlement overrides applied.
 */
export async function fetchUserLimits(): Promise<UserLimits> {
	const userApi = createUserApiClient();
	const response = await userApi.user.limits.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch user limits');
	}
	return response.json();
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
	r2BucketName?: string;
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
	const api = createApiClient(projectId);
	const response = await api.deploy.$post({ json: credentials });
	if (!response.ok) {
		await throwApiError(response, 'Failed to deploy project');
	}
	return response.json();
}

// =============================================================================
// Debug Logs
// =============================================================================

/**
 * Download an agent debug log as a JSON file.
 *
 * Fetches the debug log from the backend and triggers a browser file download.
 * This stays as an HTTP endpoint because it serves a binary/JSON file download.
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
// User: Recent Projects, Favorites, Access Tracking
// =============================================================================

/**
 * Recent project entry with cross-org access info.
 */
export interface RecentProject {
	id: string;
	organizationId: string;
	name: string;
	humanId: string;
	previewVisibility: string;
	createdByUserId: string;
	createdAt: string;
	updatedAt: string;
	lastAccessedAt: string;
	isFavorite: boolean;
	organizationName: string;
	organizationSlug: string;
}

/**
 * Fetch recently accessed projects across all orgs for the current user.
 */
export async function fetchRecentProjects(): Promise<RecentProject[]> {
	const userApi = createUserApiClient();
	const response = await userApi.user['recent-projects'].$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch recent projects');
	}
	const data = await response.json();
	return data.projects;
}

/**
 * Record that the current user accessed a project.
 */
export async function recordProjectAccess(projectId: string): Promise<void> {
	const userApi = createUserApiClient();
	await userApi.user.project[':projectId'].access.$post({ param: { projectId } });
}

/**
 * Toggle favorite status for a project.
 */
export async function toggleProjectFavorite(projectId: string, favorite: boolean): Promise<void> {
	const userApi = createUserApiClient();
	const response = await userApi.user.project[':projectId'].favorite.$put({ param: { projectId }, json: { favorite } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to update favorite');
	}
}

// =============================================================================
// Transfers
// =============================================================================

/**
 * Pending transfer entry.
 */
export interface PendingTransfer {
	id: string;
	projectId: string;
	projectName: string;
	sourceOrganizationId: string;
	sourceOrganizationName: string;
	targetOrganizationId: string;
	targetOrganizationName: string;
	createdAt: string;
}

/**
 * Fetch pending project transfers for the current user's admin orgs.
 */
export async function fetchPendingTransfers(): Promise<{ incoming: PendingTransfer[]; outgoing: PendingTransfer[] }> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.user['pending-transfers'].$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch pending transfers');
	}
	return response.json();
}

/**
 * Initiate a project transfer from one org to another.
 */
export async function initiateProjectTransfer(
	organizationId: string,
	projectId: string,
	targetOrganizationId: string,
): Promise<{ transferId: string }> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.org[':orgId'].project[':projectId'].transfer.$post({
		param: { orgId: organizationId, projectId },
		json: { targetOrganizationId },
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to initiate transfer');
	}
	return response.json();
}

/**
 * Accept a pending project transfer.
 */
export async function acceptTransfer(transferId: string): Promise<void> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.transfer[':transferId'].accept.$post({ param: { transferId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to accept transfer');
	}
}

/**
 * Reject a pending project transfer.
 */
export async function rejectTransfer(transferId: string): Promise<void> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.transfer[':transferId'].reject.$post({ param: { transferId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to reject transfer');
	}
}

/**
 * Cancel a pending project transfer.
 */
export async function cancelTransfer(transferId: string): Promise<void> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.transfer[':transferId'].cancel.$post({ param: { transferId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to cancel transfer');
	}
}

// =============================================================================
// Account Deletion
// =============================================================================

/**
 * Account deletion preview response.
 */
export interface AccountDeletePreview {
	canDelete: boolean;
	blockers: Array<{ id: string; name: string; memberCount: number }>;
	singleMemberOrganizations: Array<{ id: string; name: string; projectCount: number }>;
	membershipOrganizations: Array<{ id: string; name: string }>;
}

/**
 * Preview the consequences of deleting the current user's account.
 */
export async function fetchAccountDeletePreview(): Promise<AccountDeletePreview> {
	const userApi = createUserApiClient();
	const response = await userApi.user.account['delete-preview'].$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch account deletion preview');
	}
	return response.json();
}

/**
 * Soft-delete the current user's account.
 */
export async function deleteAccount(): Promise<void> {
	const userApi = createUserApiClient();
	const response = await userApi.user.account.$delete({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to delete account');
	}
}

/**
 * Delete an organization (super admin only).
 * Soft-deletes all projects and cancels pending transfers.
 */
export async function deleteOrganization(organizationId: string): Promise<void> {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].$delete({ param: { orgId: organizationId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to delete organization');
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
