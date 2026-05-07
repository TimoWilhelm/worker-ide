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

export interface DeployResult {
	success: boolean;
	workerName: string;
	workerUrl?: string;
	error?: string;
}

export interface DeployStatusResponse {
	instanceId: string;
	status: DeployWorkflowStatus;
	result?: DeployResult;
	error?: string;
}

export interface DeployWorkflowParameters {
	accountId: string;
	apiToken: string;
	workerName: string;
	projectId: string;
	projectRoot: string;
	organizationId: string;
	userId: string;
	requestStartedAt: number;
}
