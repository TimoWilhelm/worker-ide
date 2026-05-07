import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Database, ExternalLink, FolderOpen, Globe, Rocket, Server, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { getDeployStatus, startDeployProject } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { sanitizeR2BucketName, sanitizeWorkerName } from '@shared/deploy-helpers';
import { deployFormSchema, savedCredentialsSchema } from '@shared/validation';

import type { ProjectMeta } from '@/lib/api-client';
import type { DeployWorkflowStatus } from '@shared/deploy-types';
import type { FileInfo } from '@shared/types';
import type { SavedCredentialsParsed } from '@shared/validation';
import type { ReactNode } from 'react';

const LOCAL_STORAGE_KEY = 'worker-ide-deploy-credentials';
const CLOUDFLARE_DASHBOARD_URL = 'https://dash.cloudflare.com/';
const ACCOUNT_TOKEN_PATH = '/:account/api-tokens';
const DEPLOY_TOKEN_NAME = 'Worker IDE Deploy Token';

interface CloudflareTokenPermission {
	key: string;
	type: 'edit';
}

const DEPLOY_TOKEN_PERMISSIONS: CloudflareTokenPermission[] = [
	{ key: 'workers_scripts', type: 'edit' },
	{ key: 'workers_r2', type: 'edit' },
];

function createAccountTokenUrl(tokenName: string, permissions: CloudflareTokenPermission[]): string {
	const parameters = new URLSearchParams({
		permissionGroupKeys: JSON.stringify(permissions),
		name: tokenName,
	});

	return `${CLOUDFLARE_DASHBOARD_URL}?to=${ACCOUNT_TOKEN_PATH}&${parameters.toString()}`;
}

/**
 * Cloudflare dashboard URL for an account-scoped token with pre-filled Workers Scripts Edit + R2 Storage Edit permissions.
 * Opens the account token creation page with the correct permissions already selected.
 */
const CREATE_TOKEN_URL = createAccountTokenUrl(DEPLOY_TOKEN_NAME, DEPLOY_TOKEN_PERMISSIONS);

type SavedCredentials = SavedCredentialsParsed;

interface DeployModalProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	projectName: string;
}

type DeployState =
	| { status: 'idle' }
	| { status: 'deploying'; instanceId: string; workflowStatus: DeployWorkflowStatus }
	| { status: 'success'; workerName: string; workerUrl?: string }
	| { status: 'error'; message: string };

const DEPLOY_STATUS_LABELS: Record<DeployWorkflowStatus, string> = {
	complete: 'Complete',
	errored: 'Errored',
	paused: 'Paused',
	queued: 'Queued',
	running: 'Running',
	terminated: 'Terminated',
	unknown: 'Unknown',
	waiting: 'Waiting',
	waitingForPause: 'Waiting to pause',
};

function loadSavedCredentials(): SavedCredentials | undefined {
	try {
		const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
		if (!raw) return undefined;
		const result = savedCredentialsSchema.safeParse(JSON.parse(raw));
		if (result.success) return result.data;
	} catch {
		// Ignore invalid stored data
	}
	return undefined;
}

function saveCredentials(credentials: SavedCredentials): void {
	localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(credentials));
}

function clearSavedCredentials(): void {
	localStorage.removeItem(LOCAL_STORAGE_KEY);
}

interface DeployResourceSummaryProperties {
	workerName: string;
	hasStaticAssets: boolean;
	hasR2Storage: boolean;
}

interface DeployFormErrors {
	accountId?: string;
	apiToken?: string;
	workerName?: string;
}

interface ResourceRowProperties {
	icon: ReactNode;
	label: string;
	name: string;
}

function ResourceRow({ icon, label, name }: ResourceRowProperties) {
	return (
		<div className="flex flex-col gap-0.5 overflow-hidden">
			<div className="flex min-h-5 items-center gap-1.5 overflow-hidden">
				<span className="shrink-0 text-text-secondary">{icon}</span>
				<span className="shrink-0 font-medium text-text-primary">{label}</span>
			</div>
			<div className="pl-5">
				<span className="block truncate font-mono text-[11px] text-text-secondary">{name}</span>
			</div>
		</div>
	);
}

function DeployResourceSummary({ workerName, hasStaticAssets, hasR2Storage }: DeployResourceSummaryProperties) {
	const r2BucketName = useMemo(() => sanitizeR2BucketName(workerName), [workerName]);

	return (
		<div className="flex flex-col gap-1.5">
			<div className="text-xs font-medium text-text-secondary">Resources</div>
			<div className="rounded-md border border-border bg-bg-primary p-2.5 text-xs" aria-label="Resources to deploy">
				<ResourceRow icon={<Server className="size-3.5" />} label="Worker" name={workerName} />
				{hasStaticAssets && <ResourceRow icon={<FolderOpen className="size-3.5" />} label="Assets" name="Static assets" />}
				{hasR2Storage && <ResourceRow icon={<Database className="size-3.5" />} label="R2 bucket" name={r2BucketName} />}
				<ResourceRow icon={<Globe className="size-3.5" />} label="Route" name={`${workerName}.workers.dev`} />
			</div>
		</div>
	);
}

/**
 * Outer wrapper that handles modal open/close state.
 * Renders DeployModalContent only when open, giving it fresh state on each mount.
 */
export function DeployModal({ open, onOpenChange, projectId, projectName }: DeployModalProperties) {
	return (
		<Modal open={open} onOpenChange={onOpenChange} title="Deploy to Cloudflare" className="w-[460px]">
			{open && <DeployModalContent onOpenChange={onOpenChange} projectId={projectId} projectName={projectName} />}
		</Modal>
	);
}

/**
 * Inner content that holds form state.
 * Remounts each time the modal opens, so state is always fresh.
 */
function DeployModalContent({ onOpenChange, projectId, projectName }: Omit<DeployModalProperties, 'open'>) {
	const queryClient = useQueryClient();
	const [saved] = useState(loadSavedCredentials);
	const [accountId, setAccountId] = useState(saved?.accountId ?? '');
	const [apiToken, setApiToken] = useState(saved?.apiToken ?? '');
	const [workerName, setWorkerName] = useState(() => sanitizeWorkerName(projectName));
	const [touchedFields, setTouchedFields] = useState<Record<keyof DeployFormErrors, boolean>>({
		accountId: false,
		apiToken: false,
		workerName: false,
	});
	const [rememberCredentials, setRememberCredentials] = useState(saved !== undefined);
	const [deployState, setDeployState] = useState<DeployState>({ status: 'idle' });
	const projectMeta = queryClient.getQueryData<ProjectMeta>(['project-meta', projectId]);
	const fileTree = queryClient.getQueryData<FileInfo[]>(['files', projectId]);
	const validationResult = useMemo(
		() => deployFormSchema.safeParse({ accountId, apiToken, workerName }),
		[accountId, apiToken, workerName],
	);
	const formErrors = useMemo<DeployFormErrors>(() => {
		if (validationResult.success) {
			return {};
		}

		const fieldErrors = validationResult.error.flatten().fieldErrors;
		return {
			accountId: touchedFields.accountId ? fieldErrors.accountId?.[0] : undefined,
			apiToken: touchedFields.apiToken ? fieldErrors.apiToken?.[0] : undefined,
			workerName: touchedFields.workerName ? fieldErrors.workerName?.[0] : undefined,
		};
	}, [touchedFields, validationResult]);
	const sanitizedWorkerName = useMemo(() => sanitizeWorkerName(workerName), [workerName]);
	const hasStaticAssets =
		fileTree?.some((file) => (file.path === '/index.html' || file.path === 'index.html') && !file.isDirectory) ?? false;
	const hasR2Storage = projectMeta?.bindingsConfig?.storage === true;

	const markFieldTouched = useCallback((field: keyof DeployFormErrors) => {
		setTouchedFields((current) => ({ ...current, [field]: true }));
	}, []);

	const handleDeploy = useCallback(async () => {
		setTouchedFields({ accountId: true, apiToken: true, workerName: true });
		if (!validationResult.success) return;

		const parsedCredentials = validationResult.data;

		if (rememberCredentials) {
			saveCredentials({ accountId: parsedCredentials.accountId, apiToken: parsedCredentials.apiToken });
		} else {
			clearSavedCredentials();
		}

		try {
			const result = await startDeployProject(projectId, {
				accountId: parsedCredentials.accountId,
				apiToken: parsedCredentials.apiToken,
				workerName: sanitizedWorkerName,
			});

			setDeployState({
				status: 'deploying',
				instanceId: result.instanceId,
				workflowStatus: 'queued',
			});
		} catch (error) {
			setDeployState({
				status: 'error',
				message: error instanceof Error ? error.message : 'Deployment failed',
			});
		}
	}, [projectId, rememberCredentials, sanitizedWorkerName, validationResult]);

	useEffect(() => {
		if (deployState.status !== 'deploying') return;

		const instanceId = deployState.instanceId;
		let cancelled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		async function pollDeployStatus() {
			try {
				const status = await getDeployStatus(projectId, instanceId);
				if (cancelled) return;

				if (status.status === 'complete') {
					if (!status.result) {
						setDeployState({ status: 'error', message: 'Deployment completed without a result' });
						return;
					}

					setDeployState({ status: 'success', workerName: status.result.workerName, workerUrl: status.result.workerUrl });
					return;
				}

				if (status.status === 'errored' || status.status === 'terminated') {
					setDeployState({ status: 'error', message: status.error ?? 'Deployment failed' });
					return;
				}

				setDeployState({ status: 'deploying', instanceId: status.instanceId, workflowStatus: status.status });
				timeoutId = setTimeout(pollDeployStatus, 2000);
			} catch (error) {
				if (cancelled) return;
				setDeployState({ status: 'error', message: error instanceof Error ? error.message : 'Failed to get deployment status' });
			}
		}

		timeoutId = setTimeout(pollDeployStatus, 500);

		return () => {
			cancelled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		};
	}, [deployState, projectId]);

	const isFormValid = validationResult.success;
	const isDeploying = deployState.status === 'deploying';

	return (
		<>
			<ModalBody className="flex flex-col gap-4">
				{deployState.status === 'success' ? (
					<div className="flex flex-col items-center gap-3 py-2">
						<CheckCircle className="size-10 text-green-500" />
						<p className="text-center text-sm font-medium text-text-primary">
							Successfully deployed <strong>{deployState.workerName}</strong>
						</p>
						{deployState.workerUrl && (
							<a
								href={deployState.workerUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="
									flex items-center gap-1.5 text-sm text-accent transition-colors
									hover:text-accent-hover
								"
							>
								{deployState.workerUrl}
								<ExternalLink className="size-3" />
							</a>
						)}
					</div>
				) : deployState.status === 'error' ? (
					<div className="flex flex-col gap-3">
						<div
							className="
								flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10
								p-3
							"
						>
							<XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
							<p className="text-sm text-text-primary">{deployState.message}</p>
						</div>
					</div>
				) : deployState.status === 'deploying' ? (
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1">
							<p className="text-sm font-medium text-text-primary">Deploying to Cloudflare</p>
							<p className="text-xs text-text-secondary">Your deployment is running as a reliable Cloudflare Workflow.</p>
						</div>
						<div className="rounded-md border border-border bg-bg-primary p-3 text-sm" aria-label="Deployment workflow status">
							<div className="flex items-center gap-2">
								<div className="size-2 rounded-full bg-accent" />
								<span className="font-medium text-text-primary">Workflow status</span>
								<span className="ml-auto text-xs text-text-secondary">{DEPLOY_STATUS_LABELS[deployState.workflowStatus]}</span>
							</div>
							<p className="mt-2 text-xs text-text-secondary">
								Cloudflare exposes detailed step history in Wrangler and the dashboard. The app polls the documented Workers API status.
							</p>
						</div>
					</div>
				) : (
					<>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="deploy-account-id" className="text-xs font-medium text-text-secondary">
								Account ID
							</label>
							<input
								id="deploy-account-id"
								type="text"
								value={accountId}
								onChange={(event) => setAccountId(event.target.value)}
								onBlur={() => markFieldTouched('accountId')}
								placeholder="e.g., d64471fef208e0cf..."
								disabled={isDeploying}
								className={cn(
									`
										h-8 rounded-sm border border-border bg-bg-primary px-2.5 text-sm
										text-text-primary
									`,
									'placeholder:text-text-secondary/50',
									'focus:border-accent focus:outline-none',
									formErrors.accountId && 'border-red-500',
									'disabled:opacity-50',
								)}
							/>
							<p className="text-xs text-text-secondary">Found in the Cloudflare dashboard under Workers & Pages &gt; Overview.</p>
							{formErrors.accountId && <p className="text-xs text-red-500">{formErrors.accountId}</p>}
						</div>

						<div className="flex flex-col gap-1.5">
							<label htmlFor="deploy-api-token" className="text-xs font-medium text-text-secondary">
								API Token
							</label>
							<input
								id="deploy-api-token"
								type="password"
								value={apiToken}
								onChange={(event) => setApiToken(event.target.value)}
								onBlur={() => markFieldTouched('apiToken')}
								placeholder="Cloudflare API Token"
								disabled={isDeploying}
								className={cn(
									`
										h-8 rounded-sm border border-border bg-bg-primary px-2.5 text-sm
										text-text-primary
									`,
									'placeholder:text-text-secondary/50',
									'focus:border-accent focus:outline-none',
									formErrors.apiToken && 'border-red-500',
									'disabled:opacity-50',
								)}
							/>
							<p className="text-xs text-text-secondary">
								Needs an account-scoped token with <strong>Workers Scripts: Edit</strong> and <strong>R2 Storage: Edit</strong> permissions.{' '}
								<a href={CREATE_TOKEN_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">
									Create an account token
								</a>
							</p>
							<label className="flex cursor-pointer items-center gap-2 pt-1" htmlFor="deploy-remember">
								<input
									id="deploy-remember"
									type="checkbox"
									checked={rememberCredentials}
									onChange={(event) => setRememberCredentials(event.target.checked)}
									disabled={isDeploying}
									className="size-3.5 accent-accent"
								/>
								<span className="text-xs text-text-secondary">Remember credentials in this browser</span>
							</label>
							{formErrors.apiToken && <p className="text-xs text-red-500">{formErrors.apiToken}</p>}
						</div>

						<div className="flex flex-col gap-1.5">
							<label htmlFor="deploy-worker-name" className="text-xs font-medium text-text-secondary">
								Worker Name
							</label>
							<input
								id="deploy-worker-name"
								type="text"
								value={workerName}
								onChange={(event) => setWorkerName(event.target.value)}
								onBlur={() => markFieldTouched('workerName')}
								placeholder="my-worker"
								disabled={isDeploying}
								className={cn(
									`
										h-8 rounded-sm border border-border bg-bg-primary px-2.5 text-sm
										text-text-primary
									`,
									'placeholder:text-text-secondary/50',
									'focus:border-accent focus:outline-none',
									formErrors.workerName && 'border-red-500',
									'disabled:opacity-50',
								)}
							/>
							<p className="text-xs text-text-secondary">The name for your deployed Worker (lowercase, hyphens allowed).</p>
							{formErrors.workerName && <p className="text-xs text-red-500">{formErrors.workerName}</p>}
						</div>

						<DeployResourceSummary workerName={sanitizedWorkerName} hasStaticAssets={hasStaticAssets} hasR2Storage={hasR2Storage} />
					</>
				)}
			</ModalBody>
			<ModalFooter>
				{deployState.status === 'success' ? (
					<Button variant="secondary" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				) : deployState.status === 'error' ? (
					<>
						<Button variant="secondary" onClick={() => onOpenChange(false)}>
							Close
						</Button>
						<Button variant="default" onClick={() => setDeployState({ status: 'idle' })}>
							Try Again
						</Button>
					</>
				) : deployState.status === 'deploying' ? (
					<Button variant="secondary" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				) : (
					<>
						<Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isDeploying}>
							Cancel
						</Button>
						<Button onClick={handleDeploy} disabled={!isFormValid || isDeploying} isLoading={isDeploying} loadingText="Deploying...">
							<Rocket className="size-4" />
							Deploy
						</Button>
					</>
				)}
			</ModalFooter>
		</>
	);
}
