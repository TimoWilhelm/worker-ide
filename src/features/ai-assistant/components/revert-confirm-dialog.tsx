/**
 * Revert Confirmation Dialog
 *
 * Shows a detailed summary of what reverting a snapshot will do:
 * - Created files → will be deleted
 * - Edited files → will be restored to their original content
 * - Deleted files → will be recreated
 *
 * File paths are rendered as clickable references that open in the editor.
 */

import { useQuery } from '@tanstack/react-query';
import { AlertCircle, FileMinus, FilePen, FilePlus, Loader2, RotateCcw } from 'lucide-react';
import { AlertDialog } from 'radix-ui';

import { createApiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

import { FileReference } from './file-reference';

import type { SnapshotMetadata } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface RevertConfirmDialogProperties {
	/** Whether the dialog is open */
	open: boolean;
	/** Callback when open state changes */
	onOpenChange: (open: boolean) => void;
	/** The snapshot ID to revert */
	snapshotId: string;
	/** The index of the user message associated with this snapshot */
	messageIndex: number;
	/** The project ID for API calls */
	projectId: string;
	/** Callback when the user confirms the revert */
	onConfirm: (snapshotId: string, messageIndex: number) => void;
	/** Whether a revert is currently in progress */
	isReverting: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function RevertConfirmDialog({
	open,
	onOpenChange,
	snapshotId,
	messageIndex,
	projectId,
	onConfirm,
	isReverting,
}: RevertConfirmDialogProperties) {
	// Fetch snapshot metadata via React Query (only when dialog is open)
	const {
		data: metadata,
		isLoading,
		error,
	} = useQuery({
		queryKey: ['snapshot-detail', projectId, snapshotId],
		queryFn: async () => {
			const api = createApiClient(projectId);
			const response = await api.snapshot[':id'].$get({ param: { id: snapshotId } });
			if (!response.ok) {
				throw new Error('Failed to load snapshot details');
			}
			const data: { snapshot: SnapshotMetadata } = await response.json();
			return data.snapshot;
		},
		enabled: open && !!snapshotId,
		staleTime: 1000 * 10,
	});

	// Categorize changes
	const createdFiles = metadata?.changes.filter((change) => change.action === 'create') ?? [];
	const editedFiles = metadata?.changes.filter((change) => change.action === 'edit') ?? [];
	const deletedFiles = metadata?.changes.filter((change) => change.action === 'delete') ?? [];

	return (
		<AlertDialog.Root open={open} onOpenChange={onOpenChange}>
			<AlertDialog.Portal>
				<AlertDialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/60" />
				<AlertDialog.Content
					className={cn(
						'fixed top-1/2 left-1/2 z-50 w-[460px] max-w-[90vw] animate-fade-in',
						'-translate-1/2 rounded-lg border border-border',
						'bg-bg-secondary shadow-lg',
					)}
				>
					{/* Header */}
					<div className="flex items-center gap-2 border-b border-border px-4 py-3">
						<RotateCcw className="size-4 text-warning" />
						<AlertDialog.Title className="text-sm font-semibold text-text-primary">Revert AI Changes</AlertDialog.Title>
					</div>

					{/* Body */}
					<div className="max-h-[60vh] overflow-y-auto p-4">
						{isLoading && (
							<div
								className="
									flex items-center justify-center gap-2 py-6 text-sm text-text-secondary
								"
							>
								<Loader2 className="size-4 animate-spin" />
								Loading snapshot details...
							</div>
						)}

						{error && (
							<div
								className="
									flex items-center gap-2 rounded-md bg-error/10 px-3 py-2 text-sm
									text-error
								"
							>
								<AlertCircle className="size-4 shrink-0" />
								Failed to load snapshot details
							</div>
						)}

						{metadata && (
							<div className="flex flex-col gap-3">
								<AlertDialog.Description className="text-sm text-text-secondary">
									This will undo all changes made by the AI in response to this prompt. The following operations will be performed:
								</AlertDialog.Description>

								{/* Created files → will be deleted */}
								{createdFiles.length > 0 && (
									<ChangeGroup
										label="Will delete"
										description="Files created by AI will be removed"
										icon={<FileMinus className="size-3.5" />}
										colorClass="text-error"
										backgroundClass="bg-error/5"
										badgeClass="bg-error/15 text-error"
										changes={createdFiles}
									/>
								)}

								{/* Edited files → will be restored */}
								{editedFiles.length > 0 && (
									<ChangeGroup
										label="Will undo edits"
										description="Files will be restored to their pre-edit content"
										icon={<FilePen className="size-3.5" />}
										colorClass="text-warning"
										backgroundClass="bg-warning/5"
										badgeClass="bg-warning/15 text-warning"
										changes={editedFiles}
									/>
								)}

								{/* Deleted files → will be recreated */}
								{deletedFiles.length > 0 && (
									<ChangeGroup
										label="Will restore"
										description="Deleted files will be recreated"
										icon={<FilePlus className="size-3.5" />}
										colorClass="text-success"
										backgroundClass="bg-success/5"
										badgeClass="bg-success/15 text-success"
										changes={deletedFiles}
									/>
								)}

								{metadata.changes.length === 0 && (
									<div className="py-2 text-sm text-text-secondary">No file changes found in this snapshot.</div>
								)}
							</div>
						)}
					</div>

					{/* Footer */}
					<div className="flex justify-end gap-2 border-t border-border px-4 py-3">
						<AlertDialog.Cancel
							className={cn(
								`
									inline-flex items-center justify-center rounded-md border border-border
								`,
								'bg-bg-tertiary px-3 py-1.5 text-sm font-medium text-text-primary',
								`
									transition-colors
									hover:bg-border
								`,
							)}
						>
							Cancel
						</AlertDialog.Cancel>
						<AlertDialog.Action
							onClick={() => onConfirm(snapshotId, messageIndex)}
							disabled={isLoading || !!error || isReverting}
							className={cn(
								'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5',
								'text-sm font-medium text-white transition-colors',
								`
									bg-warning
									hover:bg-yellow-600
								`,
								'disabled:cursor-not-allowed disabled:opacity-50',
							)}
						>
							{isReverting ? (
								<>
									<Loader2 className="size-3.5 animate-spin" />
									Reverting...
								</>
							) : (
								<>
									<RotateCcw className="size-3.5" />
									Revert All
								</>
							)}
						</AlertDialog.Action>
					</div>
				</AlertDialog.Content>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}

// =============================================================================
// Change Group sub-component
// =============================================================================

function ChangeGroup({
	label,
	description,
	icon,
	colorClass,
	backgroundClass,
	badgeClass,
	changes,
}: {
	label: string;
	description: string;
	icon: React.ReactNode;
	colorClass: string;
	backgroundClass: string;
	badgeClass: string;
	changes: Array<{ path: string; action: string }>;
}) {
	return (
		<div className={cn('rounded-md border border-border', backgroundClass)}>
			{/* Group header */}
			<div className="flex items-center gap-2 px-3 py-2">
				<span
					className={cn(
						`
							inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs
							font-semibold
						`,
						badgeClass,
					)}
				>
					{icon}
					{label}
				</span>
				<span className="text-2xs text-text-secondary">{description}</span>
			</div>
			{/* File list */}
			<div className="flex flex-col gap-1 border-t border-border/50 px-3 py-2">
				{changes.map((change) => (
					<div key={change.path} className="flex items-center gap-2">
						<span className={cn('size-1 shrink-0 rounded-full', colorClass.replace('text-', 'bg-'))} />
						<FileReference path={change.path} className="text-2xs" />
					</div>
				))}
			</div>
		</div>
	);
}
