/**
 * Git Branch Selector
 *
 * Dropdown showing current branch with ability to switch, merge, and delete branches.
 */

import { ChevronDown, GitBranch, GitMerge, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
	ConfirmDialog,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui';
import { cn } from '@/lib/utils';

import type { GitBranchInfo } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

/** Branch names that are protected from deletion. */
const PROTECTED_BRANCHES = new Set(['main', 'master']);

interface GitBranchSelectorProperties {
	branches: GitBranchInfo[];
	currentBranch: string | undefined;
	onCheckout: (reference: string) => void;
	onCreateBranch: () => void;
	onMerge: (branch: string) => void;
	onDeleteBranch: (name: string) => void;
	disabled?: boolean;
	/** Whether the working directory has uncommitted changes */
	hasChanges?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function GitBranchSelector({
	branches,
	currentBranch,
	onCheckout,
	onCreateBranch,
	onMerge,
	onDeleteBranch,
	disabled,
	hasChanges,
}: GitBranchSelectorProperties) {
	const [deleteConfirm, setDeleteConfirm] = useState<string | undefined>();
	const [mergeConfirm, setMergeConfirm] = useState<string | undefined>();
	const [checkoutConfirm, setCheckoutConfirm] = useState<string | undefined>();

	const otherBranches = branches.filter((branch) => !branch.isCurrent);
	const deletableBranches = otherBranches.filter((branch) => !PROTECTED_BRANCHES.has(branch.name));

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						disabled={disabled}
						className={cn(
							'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
							`
								text-text-secondary transition-colors
								hover:bg-bg-tertiary hover:text-text-primary
							`,
							disabled && 'cursor-not-allowed opacity-50',
						)}
					>
						<GitBranch className="size-3" />
						<span className="max-w-[120px] truncate">{currentBranch ?? 'HEAD'}</span>
						<ChevronDown className="size-3" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" sideOffset={4}>
					<DropdownMenuLabel>Switch Branch</DropdownMenuLabel>
					{branches.map((branch) => (
						<DropdownMenuItem
							key={branch.name}
							onSelect={() => {
								if (branch.isCurrent) return;
								if (hasChanges) {
									setCheckoutConfirm(branch.name);
								} else {
									onCheckout(branch.name);
								}
							}}
							disabled={branch.isCurrent}
						>
							<GitBranch className="mr-2 size-3" />
							<span className="truncate">{branch.name}</span>
							{branch.isCurrent && <span className="ml-auto text-xs text-accent">current</span>}
						</DropdownMenuItem>
					))}

					{/* Merge section */}
					{otherBranches.length > 0 && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuLabel>Merge into {currentBranch ?? 'HEAD'}</DropdownMenuLabel>
							{otherBranches.map((branch) => (
								<DropdownMenuItem key={`merge-${branch.name}`} onSelect={() => setMergeConfirm(branch.name)}>
									<GitMerge className="mr-2 size-3" />
									<span className="truncate">{branch.name}</span>
								</DropdownMenuItem>
							))}
						</>
					)}

					{/* Delete section — protected branches (main/master) are excluded */}
					{deletableBranches.length > 0 && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuLabel>Delete Branch</DropdownMenuLabel>
							{deletableBranches.map((branch) => (
								<DropdownMenuItem
									key={`delete-${branch.name}`}
									onSelect={() => setDeleteConfirm(branch.name)}
									className="
										text-error
										focus:text-error
									"
								>
									<Trash2 className="mr-2 size-3" />
									<span className="truncate">{branch.name}</span>
								</DropdownMenuItem>
							))}
						</>
					)}

					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={onCreateBranch}>Create new branch...</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			{/* Switch branch confirmation (shown when there are uncommitted changes) */}
			<ConfirmDialog
				open={checkoutConfirm !== undefined}
				onOpenChange={(open) => {
					if (!open) setCheckoutConfirm(undefined);
				}}
				title="Switch Branch"
				description={
					<>
						You have uncommitted changes. Switching to <strong>{checkoutConfirm}</strong> may overwrite or discard your current changes. Are
						you sure you want to switch branches?
					</>
				}
				confirmLabel="Switch Branch"
				variant="danger"
				onConfirm={() => {
					if (checkoutConfirm) {
						onCheckout(checkoutConfirm);
					}
					setCheckoutConfirm(undefined);
				}}
			/>

			{/* Merge confirmation */}
			<ConfirmDialog
				open={mergeConfirm !== undefined}
				onOpenChange={(open) => {
					if (!open) setMergeConfirm(undefined);
				}}
				title="Merge Branch"
				description={
					<>
						This will merge all commits from <strong>{mergeConfirm}</strong> into <strong>{currentBranch ?? 'HEAD'}</strong>. If there are
						conflicting changes, you may need to resolve merge conflicts manually.
					</>
				}
				confirmLabel="Merge"
				onConfirm={() => {
					if (mergeConfirm) {
						onMerge(mergeConfirm);
					}
					setMergeConfirm(undefined);
				}}
			/>

			{/* Delete branch confirmation */}
			<ConfirmDialog
				open={deleteConfirm !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleteConfirm(undefined);
				}}
				title="Delete Branch"
				description={
					<>
						Are you sure you want to delete the branch <strong>{deleteConfirm}</strong>? Any unmerged commits on this branch will become
						unreachable. This action cannot be undone.
					</>
				}
				confirmLabel="Delete Branch"
				variant="danger"
				onConfirm={() => {
					if (deleteConfirm) {
						onDeleteBranch(deleteConfirm);
					}
					setDeleteConfirm(undefined);
				}}
			/>
		</>
	);
}
