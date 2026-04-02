/**
 * Git Clone Dialog
 *
 * Modal dialog for displaying the git clone URL and generating
 * short-lived JWT tokens for external git client access.
 */

import { Check, Copy, KeyRound } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { cn } from '@/lib/utils';

import { useGenerateGitCredentials, useGitRemote } from '../hooks/use-git-credentials';

// =============================================================================
// Types
// =============================================================================

interface GitCloneDialogProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
}

// =============================================================================
// Component
// =============================================================================

export function GitCloneDialog({ open, onOpenChange, projectId }: GitCloneDialogProperties) {
	const { cloneUrl, isLoading: isRemoteLoading } = useGitRemote({ projectId, enabled: open });
	const generateCredentials = useGenerateGitCredentials({ projectId });

	const [credentials, setCredentials] = useState<{
		token: string;
		expiresAt: string;
		username: string;
	}>();
	const [copiedField, setCopiedField] = useState<'url' | 'token' | 'command'>();

	const handleGenerate = useCallback(async () => {
		const result = await generateCredentials.mutateAsync();
		setCredentials({
			token: result.token,
			expiresAt: result.expiresAt,
			username: result.username,
		});
	}, [generateCredentials]);

	const copyToClipboard = useCallback(async (text: string, field: 'url' | 'token' | 'command') => {
		await navigator.clipboard.writeText(text);
		setCopiedField(field);
		setTimeout(() => setCopiedField(undefined), 2000);
	}, []);

	const cloneCommand =
		credentials && cloneUrl
			? `git clone https://${credentials.username}:${credentials.token}@${cloneUrl.replace(/^https?:\/\//, '')}`
			: undefined;

	return (
		<Modal open={open} onOpenChange={onOpenChange} title="Git Remote" className="w-[480px]">
			<ModalBody className="space-y-4">
				{/* Clone URL */}
				<div className="space-y-1.5">
					<label className="text-xs font-medium text-text-secondary">Clone URL</label>
					<div className="flex items-center gap-1.5">
						<input
							type="text"
							readOnly
							value={isRemoteLoading ? 'Loading...' : (cloneUrl ?? '')}
							className={cn(
								`
									flex-1 rounded-md border border-border bg-bg-primary px-2.5 py-1.5
									text-xs text-text-primary
								`,
								'focus:outline-none',
							)}
						/>
						<CopyButton
							disabled={!cloneUrl}
							copied={copiedField === 'url'}
							onClick={() => cloneUrl && void copyToClipboard(cloneUrl, 'url')}
						/>
					</div>
				</div>

				{/* Generate token */}
				{!credentials && (
					<div className="space-y-1.5">
						<label className="text-xs font-medium text-text-secondary">Credentials</label>
						<p className="text-xs text-text-secondary">
							Generate a read-only token to clone this project with an external git client. Tokens expire after 1 hour.
						</p>
						<Button variant="default" size="sm" onClick={() => void handleGenerate()} isLoading={generateCredentials.isPending}>
							<KeyRound className="size-3.5" />
							Generate Token
						</Button>
					</div>
				)}

				{/* Token display */}
				{credentials && (
					<>
						<div className="space-y-1.5">
							<label className="text-xs font-medium text-text-secondary">Token (read-only)</label>
							<div className="flex items-center gap-1.5">
								<input
									type="password"
									readOnly
									value={credentials.token}
									className={cn(
										`
											flex-1 rounded-md border border-border bg-bg-primary px-2.5 py-1.5
											font-mono text-xs text-text-primary
										`,
										'focus:outline-none',
									)}
								/>
								<CopyButton copied={copiedField === 'token'} onClick={() => void copyToClipboard(credentials.token, 'token')} />
							</div>
							<p className="text-xs text-text-secondary">Expires {new Date(credentials.expiresAt).toLocaleTimeString()}</p>
						</div>

						{/* Clone command */}
						{cloneCommand && (
							<div className="space-y-1.5">
								<label className="text-xs font-medium text-text-secondary">Clone command</label>
								<div className="flex items-start gap-1.5">
									<code
										className={cn(
											`
												flex-1 overflow-x-auto rounded-md border border-border bg-bg-primary
												px-2.5 py-1.5 text-xs break-all
											`,
											'text-text-primary',
										)}
									>
										{cloneCommand}
									</code>
									<CopyButton copied={copiedField === 'command'} onClick={() => void copyToClipboard(cloneCommand, 'command')} />
								</div>
							</div>
						)}
					</>
				)}
			</ModalBody>
			<ModalFooter>
				<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
					Close
				</Button>
			</ModalFooter>
		</Modal>
	);
}

// =============================================================================
// Copy Button
// =============================================================================

function CopyButton({ onClick, copied, disabled }: { onClick: () => void; copied: boolean; disabled?: boolean }) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				`
					flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md
					border border-border
				`,
				'text-text-secondary transition-colors',
				'hover:bg-bg-tertiary hover:text-text-primary',
				'disabled:cursor-not-allowed disabled:opacity-50',
			)}
		>
			{copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
		</button>
	);
}
