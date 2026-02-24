/**
 * Revert Confirmation Dialog
 *
 * Shows a detailed summary of what reverting a snapshot cascade will do:
 * - Created files → will be deleted
 * - Edited files → will be restored to their original content
 * - Deleted files → will be recreated
 *
 * Also detects and warns about conflicts:
 * - Files that were already approved or manually edited
 * - Files from other sessions that touch the same paths
 *
 * File paths are rendered as clickable references that open in the editor.
 */

import { useQueries } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, FileMinus, FilePen, FilePlus, Loader2, RotateCcw } from 'lucide-react';
import { AlertDialog } from 'radix-ui';
import { useMemo } from 'react';

import { createApiClient } from '@/lib/api-client';
import { useStore } from '@/lib/store';
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
	/** The snapshot IDs to revert (newest-first cascade) */
	snapshotIds: string[];
	/** The index of the user message associated with the revert point */
	messageIndex: number;
	/** The project ID for API calls */
	projectId: string;
	/** Callback when the user confirms the revert */
	onConfirm: (snapshotIds: string[], messageIndex: number) => void;
	/** Whether a revert is currently in progress */
	isReverting: boolean;
	/** Error message from a failed revert attempt */
	revertError?: string;
}

// =============================================================================
// Component
// =============================================================================

export function RevertConfirmDialog({
	open,
	onOpenChange,
	snapshotIds,
	messageIndex,
	projectId,
	onConfirm,
	isReverting,
	revertError,
}: RevertConfirmDialogProperties) {
	// Fetch metadata for all snapshots in the cascade
	const snapshotQueries = useQueries({
		queries: snapshotIds.map((snapshotId) => ({
			queryKey: ['snapshot-detail', projectId, snapshotId],
			queryFn: async () => {
				const api = createApiClient(projectId);
				const response = await api.snapshot[':id'].$get({ param: { id: snapshotId } });
				if (!response.ok) {
					throw new Error(`Failed to load snapshot ${snapshotId}`);
				}
				const data: { snapshot: SnapshotMetadata } = await response.json();
				return data.snapshot;
			},
			enabled: open,
			staleTime: 1000 * 10,
		})),
	});

	const isLoading = snapshotQueries.some((query) => query.isLoading);
	const fetchError = snapshotQueries.find((query) => query.error)?.error;
	const allMetadata = snapshotQueries.map((query) => query.data).filter((data): data is SnapshotMetadata => data !== undefined);

	// Aggregate all file changes across the cascade, deduplicating by path
	// (the first occurrence wins since snapshots are newest-first, but we
	// display all unique files regardless of which snapshot they came from)
	const aggregatedChanges = useMemo(() => {
		const seen = new Set<string>();
		const changes: Array<{ path: string; action: 'create' | 'edit' | 'delete' }> = [];
		// Process oldest-first so the earliest action for a path is kept
		for (const metadata of [...allMetadata].toReversed()) {
			for (const change of metadata.changes) {
				if (!seen.has(change.path)) {
					seen.add(change.path);
					changes.push(change);
				}
			}
		}
		return changes;
	}, [allMetadata]);

	// Categorize changes
	const createdFiles = aggregatedChanges.filter((change) => change.action === 'create');
	const editedFiles = aggregatedChanges.filter((change) => change.action === 'edit');
	const deletedFiles = aggregatedChanges.filter((change) => change.action === 'delete');

	// Detect conflicts with pending changes
	const pendingChanges = useStore((state) => state.pendingChanges);
	const warnings = useMemo(() => {
		const result: Array<{ path: string; reason: string }> = [];
		for (const change of aggregatedChanges) {
			const pending = pendingChanges.get(change.path);
			if (!pending) continue;

			if (pending.status === 'approved') {
				result.push({ path: change.path, reason: 'already accepted — your edits will be overwritten' });
			} else if (pending.status === 'rejected') {
				result.push({ path: change.path, reason: 'already rejected — will be re-reverted' });
			} else if (pending.sessionId && !snapshotIds.includes(pending.snapshotId ?? '')) {
				// The pending change is from a different session/snapshot than the ones being reverted
				const snapshotIdSet = new Set(snapshotIds);
				if (pending.snapshotId && !snapshotIdSet.has(pending.snapshotId)) {
					result.push({ path: change.path, reason: 'also modified by another session' });
				}
			}
		}
		return result;
	}, [aggregatedChanges, pendingChanges, snapshotIds]);

	const hasData = allMetadata.length > 0;
	const isCascade = snapshotIds.length > 1;

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
						<AlertDialog.Title className="text-sm font-semibold text-text-primary">
							Revert AI Changes{isCascade ? ` (${snapshotIds.length} turns)` : ''}
						</AlertDialog.Title>
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

						{fetchError && (
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

						{/* Revert API error (from a previous failed attempt) */}
						{revertError && (
							<div
								className="
									mb-3 flex items-center gap-2 rounded-md bg-error/10 px-3 py-2 text-sm
									text-error
								"
							>
								<AlertCircle className="size-4 shrink-0" />
								{revertError}
							</div>
						)}

						{hasData && (
							<div className="flex flex-col gap-3">
								<AlertDialog.Description className="text-sm text-text-secondary">
									{isCascade
										? 'This will undo all changes from this message and all subsequent AI turns. The following operations will be performed:'
										: 'This will undo all changes made by the AI in response to this prompt. The following operations will be performed:'}
								</AlertDialog.Description>

								{/* Conflict warnings */}
								{warnings.length > 0 && (
									<div className="rounded-md border border-warning/30 bg-warning/5">
										<div className="flex items-center gap-2 px-3 py-2">
											<span
												className="
													inline-flex items-center gap-1 rounded-sm bg-warning/15 px-1.5
													py-0.5 text-2xs font-semibold text-warning
												"
											>
												<AlertTriangle className="size-3.5" />
												Warning
											</span>
											<span className="text-2xs text-text-secondary">Some files have been modified since the AI change</span>
										</div>
										<div className="flex flex-col gap-1 border-t border-warning/20 px-3 py-2">
											{warnings.map((warning) => (
												<div key={warning.path} className="flex items-center gap-2">
													<span className="size-1 shrink-0 rounded-full bg-warning" />
													<FileReference path={warning.path} className="text-2xs" />
													<span className="text-2xs text-text-secondary">— {warning.reason}</span>
												</div>
											))}
										</div>
									</div>
								)}

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

								{aggregatedChanges.length === 0 && (
									<div className="py-2 text-sm text-text-secondary">No file changes found in this snapshot.</div>
								)}
							</div>
						)}
					</div>

					{/* Footer */}
					<div className="flex justify-end gap-2 border-t border-border px-4 py-3">
						<AlertDialog.Cancel
							disabled={isReverting}
							className={cn(
								`
									inline-flex items-center justify-center rounded-md border border-border
								`,
								'bg-bg-tertiary px-3 py-1.5 text-sm font-medium text-text-primary',
								`
									transition-colors
									hover:bg-border
								`,
								isReverting && 'cursor-not-allowed opacity-50',
							)}
						>
							Cancel
						</AlertDialog.Cancel>
						<AlertDialog.Action
							onClick={() => onConfirm(snapshotIds, messageIndex)}
							disabled={isLoading || !!fetchError || isReverting}
							className={cn(
								'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5',
								'text-sm font-medium text-black transition-colors',
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
