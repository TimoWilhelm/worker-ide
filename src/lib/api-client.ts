import { hc } from 'hono/client';

import { serializeMessage, parseServerMessage, type ClientMessage, type ServerMessage } from '@shared/ws-messages';

import { throwApiError } from './api-error';

import type { ApiRoutes, OrgRoutes, TransferRoutes, UserRoutes } from '@server/routes';
import type { UserPreferences } from '@shared/constants';
import type { AssetSettings, BindingsConfig, ProjectTemplateMeta } from '@shared/types';

export function createApiClient(projectId: string) {
	const baseUrl = `/p/${projectId}`;
	return hc<ApiRoutes>(`${baseUrl}/api`);
}
export type ApiClient = ReturnType<typeof createApiClient>;

export function createUserApiClient() {
	return hc<UserRoutes>('/api');
}
export function createOrgApiClient() {
	return hc<OrgRoutes>('/api');
}
export function createTransferApiClient() {
	return hc<TransferRoutes>('/api');
}

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

export async function fetchTemplates(): Promise<ProjectTemplateMeta[]> {
	const response = await fetch('/api/templates');
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch templates');
	}
	const data: { templates: ProjectTemplateMeta[] } = await response.json();
	return data.templates;
}

export async function fetchOrgProjects(organizationId: string) {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].projects.$get({ param: { orgId: organizationId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch organization projects');
	}
	const data = await response.json();
	return data.projects;
}
export type OrgProject = Awaited<ReturnType<typeof fetchOrgProjects>>[number];

export async function deleteProject(organizationId: string, projectId: string): Promise<void> {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].project[':projectId'].$delete({ param: { orgId: organizationId, projectId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to delete project');
	}
}
export async function fetchProjectMeta(
	projectId: string,
): Promise<{ name: string; assetSettings?: AssetSettings; bindingsConfig?: BindingsConfig }> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch project meta');
	}
	return response.json();
}
export async function fetchDependencies(projectId: string): Promise<Record<string, string>> {
	const api = createApiClient(projectId);
	const response = await api.dependencies.$get({});
	if (!response.ok) {
		throw new Error('Failed to fetch dependencies');
	}
	const data = await response.json();
	return data.dependencies;
}

export async function updateProjectMeta(
	projectId: string,
	meta: { name?: string; assetSettings?: AssetSettings; bindingsConfig?: BindingsConfig },
): Promise<{ name: string; assetSettings?: AssetSettings; bindingsConfig?: BindingsConfig }> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$put({ json: meta });
	if (!response.ok) {
		await throwApiError(response, 'Failed to update project meta');
	}
	return response.json();
}
export async function fetchStorageUsage(projectId: string): Promise<{ usageBytes: number; quotaBytes: number; enabled: boolean }> {
	const api = createApiClient(projectId);
	const response = await api.project.storage.$get({});
	if (!response.ok) {
		throw new Error('Failed to fetch storage usage');
	}
	return response.json();
}
export async function updateDependencies(projectId: string, dependencies: Record<string, string>): Promise<Record<string, string>> {
	const api = createApiClient(projectId);
	const response = await api.dependencies.$put({ json: { dependencies } });
	if (!response.ok) {
		throw new Error('Failed to update dependencies');
	}
	const data = await response.json();
	return data.dependencies;
}

export async function downloadProject(projectId: string): Promise<Blob> {
	const response = await fetch(`/p/${projectId}/api/download`);
	if (!response.ok) {
		await throwApiError(response, 'Failed to download project');
	}
	return response.blob();
}
export interface OrgLimits {
	maxProjects: number;
	currentProjects: number;
	maxMembers: number;
	currentMembers: number;
}
export interface UserLimits {
	maxOrganizations: number;
	currentOrganizations: number;
}

export async function fetchOrgLimits(organizationId: string): Promise<OrgLimits> {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].limits.$get({ param: { orgId: organizationId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch organization limits');
	}
	return response.json();
}

export async function fetchUserLimits(): Promise<UserLimits> {
	const userApi = createUserApiClient();
	const response = await userApi.user.limits.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch user limits');
	}
	return response.json();
}
export async function fetchUserPreferences(): Promise<UserPreferences> {
	const userApi = createUserApiClient();
	const response = await userApi.user.preferences.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch user preferences');
	}
	return response.json();
}
export async function updateUserPreferences(preferences: Record<string, string>): Promise<void> {
	const userApi = createUserApiClient();
	const response = await userApi.user.preferences.$put({ json: preferences });
	if (!response.ok) {
		await throwApiError(response, 'Failed to save user preferences');
	}
}
export interface DeployCredentials {
	accountId: string;
	apiToken: string;
	workerName?: string;
}

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
export interface RecentProject {
	id: string;
	organizationId: string;
	name: string;
	previewVisibility: string;
	createdAt: string;
	updatedAt: string;
	lastAccessedAt: string;
	isFavorite: boolean;
	organizationName: string;
	organizationSlug: string;
}
export async function fetchRecentProjects(): Promise<RecentProject[]> {
	const userApi = createUserApiClient();
	const response = await userApi.user['recent-projects'].$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch recent projects');
	}
	const data = await response.json();
	return data.projects;
}
export async function setProjectFavorite(projectId: string, favorite: boolean): Promise<void> {
	const userApi = createUserApiClient();
	const response = await userApi.user.project[':projectId'].favorite.$put({ param: { projectId }, json: { favorite } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to update favorite');
	}
}
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
export async function fetchPendingTransfers(): Promise<{ incoming: PendingTransfer[]; outgoing: PendingTransfer[] }> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.user['pending-transfers'].$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch pending transfers');
	}
	return response.json();
}
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
export async function acceptTransfer(transferId: string): Promise<void> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.transfer[':transferId'].accept.$post({ param: { transferId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to accept transfer');
	}
}
export async function rejectTransfer(transferId: string): Promise<void> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.transfer[':transferId'].reject.$post({ param: { transferId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to reject transfer');
	}
}
export async function cancelTransfer(transferId: string): Promise<void> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.transfer[':transferId'].cancel.$post({ param: { transferId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to cancel transfer');
	}
}
export interface AccountDeletePreview {
	canDelete: boolean;
	blockers: Array<{ id: string; name: string; memberCount: number }>;
	singleMemberOrganizations: Array<{ id: string; name: string; projectCount: number }>;
	membershipOrganizations: Array<{ id: string; name: string }>;
}
export async function fetchAccountDeletePreview(): Promise<AccountDeletePreview> {
	const userApi = createUserApiClient();
	const response = await userApi.user.account['delete-preview'].$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch account deletion preview');
	}
	return response.json();
}
export async function deleteAccount(): Promise<void> {
	const userApi = createUserApiClient();
	const response = await userApi.user.account.$delete({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to delete account');
	}
}

export async function deleteOrganization(organizationId: string): Promise<void> {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].$delete({ param: { orgId: organizationId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to delete organization');
	}
}

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
