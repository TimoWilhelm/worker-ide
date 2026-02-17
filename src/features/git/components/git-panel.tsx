/**
 * Git Panel
 *
 * Main Source Control sidebar panel. Contains:
 * - Branch selector
 * - Commit form
 * - Staged / Changed / Untracked file lists
 * - Collapsible history section
 *
 * Designed to match the VS Code Source Control panel layout.
 */

import { GitBranch, History, RotateCcw } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useCallback, useMemo, useState } from 'react';

import { Tooltip } from '@/components/ui';
import { toast } from '@/components/ui/toast-store';
import { createApiClient } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { GitBranchDialog } from './git-branch-dialog';
import { GitBranchSelector } from './git-branch-selector';
import { GitCommitForm } from './git-commit-form';
import { GitHistoryPanel } from './git-history-panel';
import { GitStatusList } from './git-status-list';
import { useGitBranches } from '../hooks/use-git-branches';
import { useGitLog } from '../hooks/use-git-log';
import { useGitMutations } from '../hooks/use-git-mutations';
import { useGitStatus } from '../hooks/use-git-status';
import { groupStatusEntries } from '../lib/status-helpers';

// =============================================================================
// Types
// =============================================================================

interface GitPanelProperties {
	projectId: string;
	className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function GitPanel({ projectId, className }: GitPanelProperties) {
	const [showHistory, setShowHistory] = useState(false);
	const [branchDialogOpen, setBranchDialogOpen] = useState(false);

	const openFile = useStore((state) => state.openFile);
	const showGitDiff = useStore((state) => state.showGitDiff);
	const apiClient = useMemo(() => createApiClient(projectId), [projectId]);

	// Fetch diff from API and show it in the editor
	const handleFileClick = useCallback(
		async (path: string) => {
			const normalizedPath = path.startsWith('/') ? path : `/${path}`;
			// Strip leading slash for git paths (git uses relative paths)
			const gitPath = path.startsWith('/') ? path.slice(1) : path;

			try {
				const response = await apiClient.git.diff.$get({ query: { path: gitPath } });
				const data = JSON.parse(await response.text());

				if ('error' in data) {
					// Fallback: just open the file without diff
					openFile(normalizedPath);
					return;
				}

				const diff = data.diff;
				if (diff?.beforeContent !== undefined && diff?.afterContent !== undefined) {
					showGitDiff({
						path: normalizedPath,
						beforeContent: diff.beforeContent,
						afterContent: diff.afterContent,
					});
				} else {
					// No content available (shouldn't happen), fall back to opening file
					openFile(normalizedPath);
				}
			} catch {
				// On error, just open the file without diff
				toast.error('Failed to load diff');
				openFile(normalizedPath);
			}
		},
		[apiClient, openFile, showGitDiff],
	);

	// Fetch diff for a file at a specific commit and show it in the editor
	const handleCommitFileClick = useCallback(
		async (path: string, objectId: string) => {
			const normalizedPath = path.startsWith('/') ? path : `/${path}`;
			const gitPath = path.startsWith('/') ? path.slice(1) : path;

			try {
				const response = await apiClient.git.diff.file.$get({ query: { objectId, path: gitPath } });
				const data = JSON.parse(await response.text());

				if ('error' in data) {
					openFile(normalizedPath);
					return;
				}

				const diff = data.diff;
				if (diff?.beforeContent !== undefined && diff?.afterContent !== undefined) {
					showGitDiff({
						path: normalizedPath,
						beforeContent: diff.beforeContent,
						afterContent: diff.afterContent,
						description: objectId.slice(0, 7),
					});
				} else {
					openFile(normalizedPath);
				}
			} catch {
				toast.error('Failed to load commit diff');
				openFile(normalizedPath);
			}
		},
		[apiClient, openFile, showGitDiff],
	);

	// Data hooks
	const { entries, initialized } = useGitStatus({ projectId });
	const { branches, currentBranch } = useGitBranches({ projectId, enabled: initialized });
	const { commits, isLoading: isLogLoading } = useGitLog({ projectId, enabled: initialized && showHistory });

	// Mutations
	const mutations = useGitMutations({ projectId });

	// Derived
	const groups = groupStatusEntries(entries);
	const hasStagedChanges = groups.staged.length > 0;

	// Not initialized
	if (!initialized) {
		return (
			<div className={cn('flex h-full flex-col items-center justify-center gap-2 px-4', className)}>
				<GitBranch className="size-8 text-text-secondary" />
				<p className="text-center text-sm text-text-secondary">Git not initialized</p>
			</div>
		);
	}

	return (
		<div className={cn('flex h-full flex-col', className)}>
			{/* Header */}
			<div className="flex items-center justify-between px-3 pt-1.5 pb-0.5">
				<span
					className="
						text-xs font-semibold tracking-wider text-text-secondary uppercase
					"
				>
					Source Control
				</span>
				<div className="flex items-center gap-0.5">
					<Tooltip content={showHistory ? 'Show changes' : 'Show history'}>
						<button
							type="button"
							onClick={() => setShowHistory(!showHistory)}
							className={cn(
								`
									flex size-6 cursor-pointer items-center justify-center rounded-sm
									text-text-secondary
								`,
								`
									transition-colors
									hover:bg-bg-tertiary hover:text-text-primary
								`,
								showHistory && 'text-accent',
							)}
						>
							<History className="size-3.5" />
						</button>
					</Tooltip>
					<Tooltip content="Discard all changes">
						<button
							type="button"
							onClick={() => mutations.discardAll()}
							disabled={mutations.isDiscardPending}
							className={cn(
								`
									flex size-6 cursor-pointer items-center justify-center rounded-sm
									text-text-secondary
								`,
								`
									transition-colors
									hover:bg-bg-tertiary hover:text-error
								`,
								mutations.isDiscardPending && 'cursor-not-allowed opacity-50',
							)}
						>
							<RotateCcw className="size-3.5" />
						</button>
					</Tooltip>
				</div>
			</div>

			{/* Branch selector */}
			<div className="px-2 pb-1">
				<GitBranchSelector
					branches={branches}
					currentBranch={currentBranch}
					onCheckout={(reference) => mutations.checkout(reference)}
					onCreateBranch={() => setBranchDialogOpen(true)}
					onMerge={(branch) => mutations.merge(branch)}
					onDeleteBranch={(name) => mutations.deleteBranch(name)}
					disabled={mutations.isBranchPending || mutations.isMergePending}
				/>
			</div>

			{/* Scrollable content */}
			<ScrollArea.Root className="h-full flex-1 overflow-hidden">
				<ScrollArea.Viewport className="size-full [&>div]:block! [&>div]:h-full! [&>div]:min-w-0!">
					{showHistory ? (
						<GitHistoryPanel
							projectId={projectId}
							commits={commits}
							isLoading={isLogLoading}
							branches={branches}
							onCheckout={(reference) => mutations.checkout(reference)}
							onFileClick={(path, objectId) => void handleCommitFileClick(path, objectId)}
							isCheckoutPending={mutations.isBranchPending}
						/>
					) : (
						<>
							{/* Commit form */}
							<GitCommitForm
								onCommit={(message) => mutations.commit({ message })}
								isCommitting={mutations.isCommitPending}
								isCommitSuccess={mutations.isCommitSuccess}
								hasStagedChanges={hasStagedChanges}
								error={mutations.commitError ?? undefined}
							/>

							{/* Status list */}
							<GitStatusList
								entries={entries}
								onStage={(paths) => mutations.stageFiles(paths)}
								onUnstage={(paths) => mutations.unstageFiles(paths)}
								onDiscard={(path) => mutations.discardChanges(path)}
								onFileClick={(path) => void handleFileClick(path)}
							/>
						</>
					)}
				</ScrollArea.Viewport>
				<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
					<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
				</ScrollArea.Scrollbar>
			</ScrollArea.Root>

			{/* Branch dialog */}
			<GitBranchDialog
				open={branchDialogOpen}
				onOpenChange={setBranchDialogOpen}
				onCreateBranch={(name, checkout) => {
					mutations.createBranch({ name, checkout });
					setBranchDialogOpen(false);
				}}
				isPending={mutations.isBranchPending}
			/>
		</div>
	);
}
