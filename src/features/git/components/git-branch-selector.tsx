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

interface GitBranchSelectorProperties {
	branches: GitBranchInfo[];
	currentBranch: string | undefined;
	onCheckout: (reference: string) => void;
	onCreateBranch: () => void;
	onMerge: (branch: string) => void;
	onDeleteBranch: (name: string) => void;
	disabled?: boolean;
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
}: GitBranchSelectorProperties) {
	const [deleteConfirm, setDeleteConfirm] = useState<string | undefined>();
	const [mergeConfirm, setMergeConfirm] = useState<string | undefined>();

	const otherBranches = branches.filter((branch) => !branch.isCurrent);

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
						<DropdownMenuItem key={branch.name} onSelect={() => onCheckout(branch.name)} disabled={branch.isCurrent}>
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

					{/* Delete section */}
					{otherBranches.length > 0 && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuLabel>Delete Branch</DropdownMenuLabel>
							{otherBranches.map((branch) => (
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

			{/* Merge confirmation */}
			<ConfirmDialog
				open={mergeConfirm !== undefined}
				onOpenChange={(open) => {
					if (!open) setMergeConfirm(undefined);
				}}
				title="Merge Branch"
				description={
					<>
						Merge <strong>{mergeConfirm}</strong> into <strong>{currentBranch ?? 'HEAD'}</strong>?
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

			{/* Delete confirmation */}
			<ConfirmDialog
				open={deleteConfirm !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleteConfirm(undefined);
				}}
				title="Delete Branch"
				description={
					<>
						Delete branch <strong>{deleteConfirm}</strong>? This action cannot be undone.
					</>
				}
				confirmLabel="Delete"
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
