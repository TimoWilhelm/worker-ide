import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Database, ExternalLink, FolderOpen, Globe, Loader2, Rocket, Server, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { getDeployStatus, startDeployProject } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { sanitizeR2BucketName, sanitizeWorkerName } from '@shared/deploy-helpers';
import { deployFormSchema, savedDeployAccountSchema } from '@shared/validation';

import { useCloudflareConnection } from './use-cloudflare-connection';

import type { ProjectMeta } from '@/lib/api-client';
import type { FileInfo } from '@shared/types';
import type { ReactNode } from 'react';

function accountStorageKey(projectId: string): string {
	return `worker-ide-deploy-account:${projectId}`;
}

interface DeployModalProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	projectName: string;
}

type DeployState =
	| { status: 'idle' }
	| { status: 'deploying'; instanceId: string }
	| { status: 'success'; workerName: string; workerUrl?: string; dashboardUrl?: string }
	| { status: 'error'; message: string };

function loadSavedAccountId(projectId: string): string | undefined {
	try {
		const raw = localStorage.getItem(accountStorageKey(projectId));
		if (!raw) return undefined;
		const result = savedDeployAccountSchema.safeParse(JSON.parse(raw));
		if (result.success) return result.data.accountId;
	} catch {
		// Ignore invalid stored data
	}
	return undefined;
}

function saveAccountId(projectId: string, accountId: string): void {
	try {
		localStorage.setItem(accountStorageKey(projectId), JSON.stringify({ accountId }));
	} catch {
		// Ignore storage failures (e.g., private mode)
	}
}

interface DeployResourceSummaryProperties {
	workerName: string;
	hasStaticAssets: boolean;
	hasR2Storage: boolean;
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
 * Outer wrapper that owns deploy state so it persists across modal open/close.
 * State resets only when the user dismisses the modal after a terminal result.
 */
export function DeployModal({ open, onOpenChange, projectId, projectName }: DeployModalProperties) {
	const [deployState, setDeployState] = useState<DeployState>({ status: 'idle' });

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (!nextOpen && (deployState.status === 'success' || deployState.status === 'error' || deployState.status === 'idle')) {
				setDeployState({ status: 'idle' });
			}
			onOpenChange(nextOpen);
		},
		[deployState.status, onOpenChange],
	);

	return (
		<Modal open={open} onOpenChange={handleOpenChange} title="Deploy to Cloudflare" className="w-[460px]">
			{open && (
				<DeployModalContent
					open={open}
					onOpenChange={handleOpenChange}
					projectId={projectId}
					projectName={projectName}
					deployState={deployState}
					setDeployState={setDeployState}
				/>
			)}
		</Modal>
	);
}

interface DeployModalContentProperties extends DeployModalProperties {
	deployState: DeployState;
	setDeployState: (state: DeployState) => void;
}

/**
 * Inner content that holds form state.
 * Remounts each time the modal opens, so form fields are fresh.
 * Deploy state is owned by the parent so it persists across open/close.
 */
function DeployModalContent({ open, onOpenChange, projectId, projectName, deployState, setDeployState }: DeployModalContentProperties) {
	const queryClient = useQueryClient();
	const { isLoadingConnection, connected, email, accounts, isLoadingAccounts, accountsError, connect, disconnect, isDisconnecting } =
		useCloudflareConnection(open);

	const [selectedAccountId, setSelectedAccountId] = useState(() => loadSavedAccountId(projectId) ?? '');
	const [workerName, setWorkerName] = useState(() => sanitizeWorkerName(projectName));
	const [workerNameTouched, setWorkerNameTouched] = useState(false);
	const projectMeta = queryClient.getQueryData<ProjectMeta>(['project-meta', projectId]);
	const fileTree = queryClient.getQueryData<FileInfo[]>(['files', projectId]);

	// Derive the effective account during render: the user's explicit choice when
	// it is still available, otherwise the first account. Avoids syncing state in
	// an effect.
	const accountId =
		selectedAccountId && accounts.some((account) => account.id === selectedAccountId) ? selectedAccountId : (accounts[0]?.id ?? '');

	const validationResult = useMemo(() => deployFormSchema.safeParse({ accountId, workerName }), [accountId, workerName]);
	const workerNameError = useMemo<string | undefined>(() => {
		if (validationResult.success || !workerNameTouched) return;
		return validationResult.error.flatten().fieldErrors.workerName?.[0];
	}, [validationResult, workerNameTouched]);

	const sanitizedWorkerName = useMemo(() => sanitizeWorkerName(workerName), [workerName]);
	const hasStaticAssets =
		fileTree?.some((file) => (file.path === '/index.html' || file.path === 'index.html') && !file.isDirectory) ?? false;
	const hasR2Storage = projectMeta?.bindingsConfig?.storage === true;

	const handleDeploy = useCallback(async () => {
		setWorkerNameTouched(true);
		if (!validationResult.success) return;

		const parsed = validationResult.data;
		saveAccountId(projectId, parsed.accountId);
		setDeployState({ status: 'deploying', instanceId: '' });

		try {
			const result = await startDeployProject(projectId, {
				accountId: parsed.accountId,
				workerName: sanitizedWorkerName,
			});
			setDeployState({ status: 'deploying', instanceId: result.instanceId });
		} catch (error) {
			setDeployState({
				status: 'error',
				message: error instanceof Error ? error.message : 'Deployment failed',
			});
		}
	}, [projectId, sanitizedWorkerName, setDeployState, validationResult]);

	useEffect(() => {
		if (deployState.status !== 'deploying' || !deployState.instanceId) return;

		const instanceId = deployState.instanceId;
		let cancelled = false;
		let consecutiveErrors = 0;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const MAX_CONSECUTIVE_POLL_ERRORS = 3;

		async function pollDeployStatus() {
			try {
				const status = await getDeployStatus(projectId, instanceId);
				if (cancelled) return;
				consecutiveErrors = 0;

				if (status.error) {
					setDeployState({ status: 'error', message: status.error });
					return;
				}

				if (status.status === 'complete' && status.result) {
					setDeployState({
						status: 'success',
						workerName: status.result.workerName,
						workerUrl: status.result.workerUrl,
						dashboardUrl: status.result.dashboardUrl,
					});
					return;
				}

				if (status.status === 'complete') {
					setDeployState({ status: 'error', message: 'Deployment failed' });
					return;
				}

				if (status.status === 'errored' || status.status === 'terminated') {
					setDeployState({ status: 'error', message: 'Deployment failed' });
					return;
				}

				setDeployState({ status: 'deploying', instanceId: status.instanceId });
				timeoutId = setTimeout(pollDeployStatus, 2000);
			} catch {
				if (cancelled) return;
				consecutiveErrors++;
				if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
					setDeployState({ status: 'error', message: 'Lost connection to the deployment. Please try again.' });
					return;
				}
				timeoutId = setTimeout(pollDeployStatus, 3000);
			}
		}

		timeoutId = setTimeout(pollDeployStatus, 500);

		return () => {
			cancelled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		};
	}, [deployState, projectId, setDeployState]);

	const isDeploying = deployState.status === 'deploying';
	const canDeploy = connected && validationResult.success && !isDeploying;

	return (
		<>
			<ModalBody className="flex flex-col gap-4">
				{deployState.status === 'success' ? (
					<div className="flex flex-col items-center gap-3 py-2">
						<CheckCircle className="size-10 text-green-500" />
						<p className="text-center text-sm font-medium text-text-primary">
							Successfully deployed <strong>{deployState.workerName}</strong>
						</p>
						<div className="flex flex-col gap-2">
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
									<Globe className="size-3.5 shrink-0" />
									{deployState.workerUrl}
									<ExternalLink className="size-3 shrink-0" />
								</a>
							)}
							{deployState.dashboardUrl && (
								<a
									href={deployState.dashboardUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="
										flex items-center gap-1.5 text-sm text-accent transition-colors
										hover:text-accent-hover
									"
								>
									<Server className="size-3.5 shrink-0" />
									Manage in Cloudflare Dashboard
									<ExternalLink className="size-3 shrink-0" />
								</a>
							)}
						</div>
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
					<div className="flex flex-col items-center gap-3 py-6">
						<Loader2 className="size-8 animate-spin text-accent" />
						<p className="text-sm font-medium text-text-primary">Deploying&hellip;</p>
						<p className="text-xs text-text-secondary">This may take a moment.</p>
					</div>
				) : isLoadingConnection ? (
					<div className="flex flex-col items-center gap-3 py-6">
						<Loader2 className="size-6 animate-spin text-accent" />
						<p className="text-xs text-text-secondary">Checking Cloudflare connection&hellip;</p>
					</div>
				) : connected ? (
					<>
						<div
							className="
								flex items-center justify-between gap-2 rounded-md border border-border
								bg-bg-primary p-2.5 text-xs
							"
						>
							<div className="flex items-center gap-1.5 overflow-hidden">
								<CheckCircle className="size-3.5 shrink-0 text-green-500" />
								<span className="truncate text-text-secondary">Connected{email ? ` as ${email}` : ''}</span>
							</div>
							<button
								type="button"
								onClick={() => disconnect()}
								disabled={isDisconnecting}
								className="
									shrink-0 text-text-secondary underline transition-colors
									hover:text-text-primary
									disabled:opacity-50
								"
							>
								Disconnect
							</button>
						</div>

						<div className="flex flex-col gap-1.5">
							<label htmlFor="deploy-account-id" className="text-xs font-medium text-text-secondary">
								Cloudflare Account
							</label>
							<select
								id="deploy-account-id"
								value={accountId}
								onChange={(event) => setSelectedAccountId(event.target.value)}
								disabled={isDeploying || isLoadingAccounts || accounts.length === 0}
								className={cn(
									`
										h-8 rounded-sm border border-border bg-bg-primary px-2.5 text-sm
										text-text-primary
									`,
									'focus:border-accent focus:outline-none',
									'disabled:opacity-50',
								)}
							>
								{accounts.length === 0 ? (
									<option value="">{isLoadingAccounts ? 'Loading accounts…' : 'No accounts available'}</option>
								) : (
									accounts.map((account) => (
										<option key={account.id} value={account.id}>
											{account.name}
										</option>
									))
								)}
							</select>
							{accountsError && <p className="text-xs text-red-500">Failed to load accounts. Try reconnecting.</p>}
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
								onBlur={() => setWorkerNameTouched(true)}
								placeholder="my-worker"
								disabled={isDeploying}
								className={cn(
									`
										h-8 rounded-sm border border-border bg-bg-primary px-2.5 text-sm
										text-text-primary
									`,
									'placeholder:text-text-secondary/50',
									'focus:border-accent focus:outline-none',
									workerNameError && 'border-red-500',
									'disabled:opacity-50',
								)}
							/>
							<p className="text-xs text-text-secondary">The name for your deployed Worker (lowercase, hyphens allowed).</p>
							{workerNameError && <p className="text-xs text-red-500">{workerNameError}</p>}
						</div>

						<DeployResourceSummary workerName={sanitizedWorkerName} hasStaticAssets={hasStaticAssets} hasR2Storage={hasR2Storage} />
					</>
				) : (
					<div className="flex flex-col items-center gap-3 py-4 text-center">
						<Server className="size-8 text-text-secondary" />
						<p className="text-sm font-medium text-text-primary">Connect your Cloudflare account</p>
						<p className="text-xs text-text-secondary">
							Authorize Worker IDE to deploy Workers to your Cloudflare account. You will be asked to grant access to Workers Scripts and R2
							Storage.
						</p>
						<Button onClick={connect}>
							<ExternalLink className="size-4" />
							Connect Cloudflare
						</Button>
					</div>
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
						{connected && (
							<Button onClick={handleDeploy} disabled={!canDeploy} isLoading={isDeploying}>
								<Rocket className="size-4" />
								Deploy
							</Button>
						)}
					</>
				)}
			</ModalFooter>
		</>
	);
}
