import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useQueries } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, FileMinus, FilePen, FilePlus, RotateCcw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { useDeferredOpen } from '@/hooks/use-deferred-open';
import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { modalContentVariants, overlayVariants, springDefault, tweenFast } from '@/lib/motion-config';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { FileReference } from './file-reference';

import type { SnapshotMetadata } from '@shared/types';

interface RevertConfirmDialogProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	snapshotIds: string[];
	messageIndex: number;
	projectId: string;
	onConfirm: (snapshotIds: string[], messageIndex: number) => void;
	isReverting: boolean;
	revertError?: string;
}

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
					await throwApiError(response, `Failed to load snapshot ${snapshotId}`);
				}
				const data: { snapshot: SnapshotMetadata } = await response.json();
				return data.snapshot;
			},
			enabled: open,
			staleTime: 1000 * 10,
		})),
	});

	const isLoading = snapshotQueries.some((query) => query.isLoading);
	const allMetadata = snapshotQueries.map((query) => query.data).filter((data): data is SnapshotMetadata => data !== undefined);

	// Only show a fetch error if some queries failed but others succeeded (partial failure).
	// If ALL queries failed, the snapshots were likely cleaned up (no file changes) —
	// treat this as a valid "no changes" case rather than a hard error.
	const failedCount = snapshotQueries.filter((query) => query.error).length;
	const allFailed = failedCount > 0 && failedCount === snapshotQueries.length;
	const fetchError = allFailed ? undefined : snapshotQueries.find((query) => query.error)?.error;

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
		const snapshotIdSet = new Set(snapshotIds);
		for (const change of aggregatedChanges) {
			const pending = pendingChanges.get(change.path);
			if (!pending) continue;

			if (pending.status === 'approved') {
				result.push({ path: change.path, reason: 'already accepted — your edits will be overwritten' });
			} else if (pending.status === 'rejected') {
				result.push({ path: change.path, reason: 'already rejected — will be re-reverted' });
			} else if (pending.snapshotId && !snapshotIdSet.has(pending.snapshotId)) {
				result.push({ path: change.path, reason: 'pending change from another session — not affected' });
			}
		}
		return result;
	}, [aggregatedChanges, pendingChanges, snapshotIds]);

	const hasData = snapshotIds.length === 0 || allMetadata.length > 0 || allFailed;
	const isCascade = snapshotIds.length > 1;
	const { dialogOpen, show, onExitComplete } = useDeferredOpen(open);
	const summary =
		snapshotIds.length === 0 || aggregatedChanges.length === 0
			? isCascade
				? 'Removes this message and everything after it. Your files stay as they are.'
				: 'Removes this message from the history. Your files stay as they are.'
			: isCascade
				? 'Rolls back every AI change from this message onward.'
				: 'Rolls back the AI changes from this message.';

	return (
		<AlertDialog.Root open={dialogOpen} onOpenChange={onOpenChange}>
			<AnimatePresence onExitComplete={onExitComplete}>
				{show && (
					<AlertDialog.Portal keepMounted>
						<AlertDialog.Backdrop
							render={<motion.div variants={overlayVariants} initial="hidden" animate="visible" exit="exit" transition={tweenFast} />}
							className="fixed inset-0 z-50 bg-black/60"
						/>
						<AlertDialog.Popup
							render={
								<motion.div variants={modalContentVariants} initial="hidden" animate="visible" exit="exit" transition={springDefault} />
							}
							className={cn(
								'fixed top-1/2 left-1/2 z-50 w-[460px] max-w-[90vw]',
								'-translate-1/2 rounded-lg border border-border',
								'bg-bg-secondary shadow-lg',
							)}
						>
							<div className="flex items-center gap-2 border-b border-border px-4 py-3">
								<RotateCcw className="size-4 text-warning" />
								<AlertDialog.Title className="text-sm font-semibold text-text-primary">
									Revert AI Changes{isCascade ? ` (${snapshotIds.length} turns)` : ''}
								</AlertDialog.Title>
							</div>

							<div className="max-h-[60vh] overflow-y-auto p-4">
								{isLoading && (
									<div
										className="
											flex items-center justify-center gap-2 py-6 text-sm
											text-text-secondary
										"
									>
										<Spinner className="size-4" />
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
										<AlertDialog.Description className="text-sm text-text-secondary">{summary}</AlertDialog.Description>

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
													<span className="text-2xs text-text-secondary">These files changed since then.</span>
												</div>
												<div
													className="
														flex flex-col gap-1 border-t border-warning/20 px-3 py-2
													"
												>
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

										{createdFiles.length > 0 && (
											<ChangeGroup
												label="Delete"
												description="New AI files"
												icon={<FileMinus className="size-3.5" />}
												colorClass="text-error"
												backgroundClass="bg-error/5"
												badgeClass="bg-error/15 text-error"
												changes={createdFiles}
											/>
										)}

										{editedFiles.length > 0 && (
											<ChangeGroup
												label="Undo edits"
												description="Edited files"
												icon={<FilePen className="size-3.5" />}
												colorClass="text-warning"
												backgroundClass="bg-warning/5"
												badgeClass="bg-warning/15 text-warning"
												changes={editedFiles}
											/>
										)}

										{deletedFiles.length > 0 && (
											<ChangeGroup
												label="Restore"
												description="Deleted files"
												icon={<FilePlus className="size-3.5" />}
												colorClass="text-success"
												backgroundClass="bg-success/5"
												badgeClass="bg-success/15 text-success"
												changes={deletedFiles}
											/>
										)}
									</div>
								)}
							</div>

							<div className="flex justify-end gap-2 border-t border-border px-4 py-3">
								<AlertDialog.Close
									disabled={isReverting}
									className={cn(
										`
											inline-flex items-center justify-center rounded-md border
											border-border
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
								</AlertDialog.Close>
								<button
									type="button"
									onClick={() => onConfirm(snapshotIds, messageIndex)}
									disabled={isLoading || !!fetchError || isReverting}
									className={cn(
										`
											inline-flex items-center justify-center gap-1.5 rounded-md px-3
											py-1.5
										`,
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
											<Spinner className="size-3.5" />
											Reverting...
										</>
									) : (
										<>
											<RotateCcw className="size-3.5" />
											Revert
										</>
									)}
								</button>
							</div>
						</AlertDialog.Popup>
					</AlertDialog.Portal>
				)}
			</AnimatePresence>
		</AlertDialog.Root>
	);
}

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
