export type DeployWorkflowStatus =
	| 'queued'
	| 'running'
	| 'paused'
	| 'errored'
	| 'terminated'
	| 'complete'
	| 'waiting'
	| 'waitingForPause'
	| 'unknown';

export interface DeployStartResponse {
	instanceId: string;
}

/** Whether the authenticated user has linked their Cloudflare account via OAuth. */
export interface CloudflareConnectionStatus {
	connected: boolean;
	/** Email of the linked Cloudflare user, when known. */
	email?: string;
}

/** A Cloudflare account the user can deploy into. */
export interface CloudflareAccount {
	id: string;
	name: string;
}

export interface CloudflareAccountsResponse {
	accounts: CloudflareAccount[];
}

export interface DeployResult {
	success: boolean;
	workerName: string;
	workerUrl?: string;
	dashboardUrl?: string;
	error?: string;
}

export interface DeployStatusResponse {
	instanceId: string;
	status: DeployWorkflowStatus;
	result?: DeployResult;
	error?: string;
}

export interface DeployWorkflowParameters {
	/** Cloudflare account ID the user selected to deploy into. */
	accountId: string;
	workerName: string;
	projectId: string;
	projectRoot: string;
	organizationId: string;
	/** IDE user ID; used to look up + refresh the user's Cloudflare OAuth tokens. */
	userId: string;
	requestStartedAt: number;
}
