/**
 * Git Commit Detail
 *
 * Shows details for a single commit: hash, author, date, message, and changed files.
 * Includes a "Checkout" button to restore the project to this commit's state.
 */

import { ArrowLeft, Clock, GitCommitHorizontal, User } from 'lucide-react';
import { useState } from 'react';

import { Button, ConfirmDialog } from '@/components/ui';
import { cn } from '@/lib/utils';

import type { GitCommitEntry, GitFileDiff } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface GitCommitDetailProperties {
	commit: GitCommitEntry;
	files?: GitFileDiff[];
	isLoadingDiff?: boolean;
	onBack: () => void;
	onCheckout: (reference: string) => void;
	onFileClick: (path: string, objectId: string) => void;
	isCheckoutPending?: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function formatDate(timestamp: number): string {
	return new Date(timestamp * 1000).toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

// =============================================================================
// Component
// =============================================================================

export function GitCommitDetail({
	commit,
	files,
	isLoadingDiff,
	onBack,
	onCheckout,
	onFileClick,
	isCheckoutPending,
}: GitCommitDetailProperties) {
	const [checkoutConfirmOpen, setCheckoutConfirmOpen] = useState(false);

	return (
		<div className="flex flex-col">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2">
				<button
					type="button"
					onClick={onBack}
					className="
						flex items-center gap-1.5 text-xs text-text-secondary transition-colors
						hover:text-text-primary
					"
				>
					<ArrowLeft className="size-3" />
					Back to history
				</button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setCheckoutConfirmOpen(true)}
					disabled={isCheckoutPending}
					isLoading={isCheckoutPending}
					className="h-6 gap-1 px-2 text-xs"
				>
					<GitCommitHorizontal className="size-3" />
					Checkout
				</Button>
			</div>

			{/* Commit info */}
			<div className="border-b border-border px-3 pb-3">
				<p className="text-sm text-text-primary">{commit.message}</p>
				<div className="mt-2 flex flex-col gap-1 text-xs text-text-secondary">
					<span className="flex items-center gap-1.5">
						<User className="size-3" />
						{commit.author.name}
					</span>
					<span className="flex items-center gap-1.5">
						<Clock className="size-3" />
						{formatDate(commit.author.timestamp)}
					</span>
					<span className="font-mono text-[10px] text-text-secondary">{commit.abbreviatedObjectId}</span>
				</div>
			</div>

			{/* Changed files */}
			<div className="px-3 pt-2">
				<span
					className="
						text-xs font-semibold tracking-wider text-text-secondary uppercase
					"
				>
					Changed Files
				</span>
				{isLoadingDiff && <p className="py-2 text-xs text-text-secondary">Loading diff...</p>}
				{files && files.length === 0 && <p className="py-2 text-xs text-text-secondary">No file changes</p>}
				{files && files.length > 0 && (
					<div className="mt-1 flex flex-col">
						{files.map((file) => (
							<button
								key={file.path}
								type="button"
								onClick={() => onFileClick(file.path, commit.objectId)}
								disabled={file.status === 'deleted'}
								className={cn(
									'flex items-center gap-2 rounded-sm py-1 text-left text-xs',
									`
										transition-colors
										hover:bg-bg-tertiary
									`,
									file.status === 'deleted' && 'cursor-default opacity-60',
								)}
							>
								<span
									className={cn(
										'shrink-0 font-medium',
										file.status === 'added' && 'text-emerald-400',
										file.status === 'modified' && 'text-sky-400',
										file.status === 'deleted' && 'text-red-400',
									)}
								>
									{file.status === 'added' ? 'A' : file.status === 'modified' ? 'M' : 'D'}
								</span>
								<span className="min-w-0 truncate text-text-primary">{file.path}</span>
							</button>
						))}
					</div>
				)}
			</div>

			{/* Checkout confirmation */}
			<ConfirmDialog
				open={checkoutConfirmOpen}
				onOpenChange={setCheckoutConfirmOpen}
				title="Checkout Commit"
				description={
					<>
						Switch to commit <strong className="font-mono">{commit.abbreviatedObjectId}</strong>? This will put the repository in a detached
						HEAD state. Any uncommitted changes will be lost.
					</>
				}
				confirmLabel="Checkout"
				variant="danger"
				onConfirm={() => {
					onCheckout(commit.objectId);
					setCheckoutConfirmOpen(false);
				}}
			/>
		</div>
	);
}
