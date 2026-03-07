/**
 * Deploy Modal Component
 *
 * Modal dialog for deploying the project to the user's Cloudflare account.
 * Collects Account ID and API Token, with optional saved credentials in localStorage.
 */

import { CheckCircle, ExternalLink, Rocket, XCircle } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { deployProject } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { savedCredentialsSchema } from '@shared/validation';

import type { SavedCredentialsParsed } from '@shared/validation';

// =============================================================================
// Constants
// =============================================================================

const LOCAL_STORAGE_KEY = 'worker-ide-deploy-credentials';

/**
 * Cloudflare dashboard URL with pre-filled Workers Scripts Edit permissions.
 * Opens the token creation page with the correct permissions already selected.
 */
const CREATE_TOKEN_URL =
	'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=%2A&zoneId=all&name=Worker%20IDE%20Deploy%20Token';

// =============================================================================
// Types
// =============================================================================

type SavedCredentials = SavedCredentialsParsed;

interface DeployModalProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	projectName: string;
}

type DeployState =
	| { status: 'idle' }
	| { status: 'deploying' }
	| { status: 'success'; workerName: string; workerUrl?: string }
	| { status: 'error'; message: string };

// =============================================================================
// Helpers
// =============================================================================

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

function sanitizeWorkerName(name: string): string {
	return (
		name
			.toLowerCase()
			.replaceAll(/[^a-z\d-]/g, '-')
			.replaceAll(/-+/g, '-')
			.replaceAll(/^-|-$/g, '')
			.slice(0, 63) || 'my-worker'
	);
}

// =============================================================================
// Component
// =============================================================================

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
	const [saved] = useState(loadSavedCredentials);
	const [accountId, setAccountId] = useState(saved?.accountId ?? '');
	const [apiToken, setApiToken] = useState(saved?.apiToken ?? '');
	const [workerName, setWorkerName] = useState(() => sanitizeWorkerName(projectName));
	const [rememberCredentials, setRememberCredentials] = useState(saved !== undefined);
	const [deployState, setDeployState] = useState<DeployState>({ status: 'idle' });

	const handleDeploy = useCallback(async () => {
		if (!accountId.trim() || !apiToken.trim()) return;

		setDeployState({ status: 'deploying' });

		// Save or clear credentials based on user preference
		if (rememberCredentials) {
			saveCredentials({ accountId: accountId.trim(), apiToken: apiToken.trim() });
		} else {
			clearSavedCredentials();
		}

		try {
			const result = await deployProject(projectId, {
				accountId: accountId.trim(),
				apiToken: apiToken.trim(),
				workerName: workerName.trim() || undefined,
			});

			setDeployState({
				status: 'success',
				workerName: result.workerName,
				workerUrl: result.workerUrl,
			});
		} catch (error) {
			setDeployState({
				status: 'error',
				message: error instanceof Error ? error.message : 'Deployment failed',
			});
		}
	}, [accountId, apiToken, workerName, rememberCredentials, projectId]);

	const isFormValid = accountId.trim().length > 0 && apiToken.trim().length > 0;
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
				) : (
					<>
						{/* Account ID */}
						<div className="flex flex-col gap-1.5">
							<label htmlFor="deploy-account-id" className="text-xs font-medium text-text-secondary">
								Account ID
							</label>
							<input
								id="deploy-account-id"
								type="text"
								value={accountId}
								onChange={(event) => setAccountId(event.target.value)}
								placeholder="e.g., d64471fef208e0cf..."
								disabled={isDeploying}
								className={cn(
									`
										h-8 rounded-sm border border-border bg-bg-primary px-2.5 text-sm
										text-text-primary
									`,
									'placeholder:text-text-secondary/50',
									'focus:border-accent focus:outline-none',
									'disabled:opacity-50',
								)}
							/>
							<p className="text-xs text-text-secondary">Found in the Cloudflare dashboard under Workers & Pages &gt; Overview.</p>
						</div>

						{/* API Token */}
						<div className="flex flex-col gap-1.5">
							<label htmlFor="deploy-api-token" className="text-xs font-medium text-text-secondary">
								API Token
							</label>
							<input
								id="deploy-api-token"
								type="password"
								value={apiToken}
								onChange={(event) => setApiToken(event.target.value)}
								placeholder="Cloudflare API Token"
								disabled={isDeploying}
								className={cn(
									`
										h-8 rounded-sm border border-border bg-bg-primary px-2.5 text-sm
										text-text-primary
									`,
									'placeholder:text-text-secondary/50',
									'focus:border-accent focus:outline-none',
									'disabled:opacity-50',
								)}
							/>
							<p className="text-xs text-text-secondary">
								Needs <strong>Workers Scripts: Edit</strong> permission.{' '}
								<a href={CREATE_TOKEN_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">
									Create a token
								</a>
							</p>
						</div>

						{/* Worker Name */}
						<div className="flex flex-col gap-1.5">
							<label htmlFor="deploy-worker-name" className="text-xs font-medium text-text-secondary">
								Worker Name
							</label>
							<input
								id="deploy-worker-name"
								type="text"
								value={workerName}
								onChange={(event) => setWorkerName(event.target.value)}
								placeholder="my-worker"
								disabled={isDeploying}
								className={cn(
									`
										h-8 rounded-sm border border-border bg-bg-primary px-2.5 text-sm
										text-text-primary
									`,
									'placeholder:text-text-secondary/50',
									'focus:border-accent focus:outline-none',
									'disabled:opacity-50',
								)}
							/>
							<p className="text-xs text-text-secondary">The name for your deployed Worker (lowercase, hyphens allowed).</p>
						</div>

						{/* Remember credentials */}
						<label className="flex cursor-pointer items-center gap-2" htmlFor="deploy-remember">
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
