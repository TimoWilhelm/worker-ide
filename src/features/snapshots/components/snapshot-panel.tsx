/**
 * Snapshot Panel Component
 *
 * Displays a list of project snapshots with the ability to view details and revert.
 */

import { Clock, FileText, History, Loader2, RotateCcw, X } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn, formatRelativeTime } from '@/lib/utils';

import { useSnapshots } from '../hooks/use-snapshots';

import type { SnapshotMetadata, SnapshotSummary } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface SnapshotPanelProperties {
	projectId: string;
	className?: string;
	onClose?: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Panel for viewing and reverting project snapshots.
 */
export function SnapshotPanel({ projectId, className, onClose }: SnapshotPanelProperties) {
	const { snapshots, isLoading, isError, refetch, getSnapshotDetail, revertSnapshot, revertFile, isReverting } = useSnapshots({
		projectId,
	});

	const [selectedSnapshot, setSelectedSnapshot] = useState<SnapshotMetadata | undefined>();
	const [isLoadingDetail, setIsLoadingDetail] = useState(false);

	// Load snapshot detail
	const handleSelectSnapshot = useCallback(
		async (snapshotId: string) => {
			setIsLoadingDetail(true);
			try {
				const detail = await getSnapshotDetail(snapshotId);
				setSelectedSnapshot(detail);
			} finally {
				setIsLoadingDetail(false);
			}
		},
		[getSnapshotDetail],
	);

	// Revert entire snapshot
	const handleRevertSnapshot = useCallback(
		(snapshotId: string) => {
			revertSnapshot(snapshotId);
			setSelectedSnapshot(undefined);
		},
		[revertSnapshot],
	);

	// Revert a single file
	const handleRevertFile = useCallback(
		(path: string, snapshotId: string) => {
			revertFile({ path, snapshotId });
		},
		[revertFile],
	);

	// Go back to list view
	const handleBack = useCallback(() => {
		setSelectedSnapshot(undefined);
	}, []);

	return (
		<div className={cn('flex h-full flex-col bg-bg-secondary', className)}>
			{/* Header */}
			<div
				className={`
					flex h-10 shrink-0 items-center justify-between border-b border-border px-3
				`}
			>
				<div className="flex items-center gap-2">
					<History className="size-4 text-accent" />
					<span className="text-sm font-medium text-text-primary">{selectedSnapshot ? 'Snapshot Detail' : 'Snapshots'}</span>
				</div>
				<div className="flex items-center gap-1">
					{selectedSnapshot && (
						<Tooltip content="Back to list">
							<Button variant="ghost" size="icon" className="size-7" onClick={handleBack}>
								<RotateCcw className="size-3.5" />
							</Button>
						</Tooltip>
					)}
					{onClose && (
						<Tooltip content="Close">
							<Button variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={onClose}>
								<X className="size-3.5" />
							</Button>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Content */}
			{isLoading ? (
				<div className="flex flex-1 items-center justify-center">
					<Loader2 className="size-5 animate-spin text-text-secondary" />
				</div>
			) : isError ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
					<p className="text-sm text-error">Failed to load snapshots</p>
					<Button variant="secondary" size="sm" onClick={() => void refetch()}>
						Retry
					</Button>
				</div>
			) : selectedSnapshot ? (
				<SnapshotDetailView
					snapshot={selectedSnapshot}
					isReverting={isReverting}
					isLoadingDetail={isLoadingDetail}
					onRevertSnapshot={handleRevertSnapshot}
					onRevertFile={handleRevertFile}
				/>
			) : snapshots.length === 0 ? (
				<div
					className={`
						flex flex-1 flex-col items-center justify-center py-8 text-center
						text-text-secondary
					`}
				>
					<History className="mb-2 size-8" />
					<p className="text-sm">No snapshots yet</p>
					<p className="mt-1 text-xs">Snapshots are created when the AI makes changes.</p>
				</div>
			) : (
				<SnapshotListView snapshots={snapshots} isReverting={isReverting} onSelect={handleSelectSnapshot} onRevert={handleRevertSnapshot} />
			)}
		</div>
	);
}

// =============================================================================
// Sub-components
// =============================================================================

function SnapshotListView({
	snapshots,
	isReverting,
	onSelect,
	onRevert,
}: {
	snapshots: SnapshotSummary[];
	isReverting: boolean;
	onSelect: (id: string) => void;
	onRevert: (id: string) => void;
}) {
	return (
		<ScrollArea.Root className="flex-1 overflow-hidden">
			<ScrollArea.Viewport className="size-full">
				<div className="flex flex-col gap-1 p-2">
					{snapshots.map((snapshot) => (
						<SnapshotListItem
							key={snapshot.id}
							snapshot={snapshot}
							isReverting={isReverting}
							onSelect={() => void onSelect(snapshot.id)}
							onRevert={() => onRevert(snapshot.id)}
						/>
					))}
				</div>
			</ScrollArea.Viewport>
			<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
				<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
			</ScrollArea.Scrollbar>
		</ScrollArea.Root>
	);
}

function SnapshotListItem({
	snapshot,
	isReverting,
	onSelect,
	onRevert,
}: {
	snapshot: SnapshotSummary;
	isReverting: boolean;
	onSelect: () => void;
	onRevert: () => void;
}) {
	return (
		<div
			className={`
				group flex flex-col gap-1 rounded-sm border border-border bg-bg-tertiary
				p-2.5 transition-colors
				hover:border-accent/50
			`}
		>
			<button type="button" onClick={onSelect} className="flex cursor-pointer flex-col items-start gap-1 text-left">
				<span className="text-sm font-medium text-text-primary">{snapshot.label}</span>
				<div className="flex items-center gap-3 text-xs text-text-secondary">
					<span className="flex items-center gap-1">
						<Clock className="size-3" />
						{formatRelativeTime(snapshot.timestamp)}
					</span>
					<span className="flex items-center gap-1">
						<FileText className="size-3" />
						{snapshot.changeCount} {snapshot.changeCount === 1 ? 'file' : 'files'}
					</span>
				</div>
			</button>
			<div
				className={`
					flex justify-end opacity-0 transition-opacity
					group-hover:opacity-100
				`}
			>
				<Button
					variant="secondary"
					size="sm"
					onClick={(event) => {
						event.stopPropagation();
						onRevert();
					}}
					disabled={isReverting}
					className="h-6 text-xs"
				>
					{isReverting ? <Loader2 className="mr-1 size-3 animate-spin" /> : <RotateCcw className="mr-1 size-3" />}
					Revert
				</Button>
			</div>
		</div>
	);
}

const ACTION_COLORS: Record<string, string> = {
	create: 'text-green-400',
	edit: 'text-yellow-400',
	delete: 'text-red-400',
};

const ACTION_LABELS: Record<string, string> = {
	create: 'Created',
	edit: 'Modified',
	delete: 'Deleted',
};

function SnapshotDetailView({
	snapshot,
	isReverting,
	isLoadingDetail,
	onRevertSnapshot,
	onRevertFile,
}: {
	snapshot: SnapshotMetadata;
	isReverting: boolean;
	isLoadingDetail: boolean;
	onRevertSnapshot: (id: string) => void;
	onRevertFile: (path: string, snapshotId: string) => void;
}) {
	if (isLoadingDetail) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Loader2 className="size-5 animate-spin text-text-secondary" />
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			{/* Snapshot info */}
			<div className="shrink-0 border-b border-border p-3">
				<h3 className="text-sm font-medium text-text-primary">{snapshot.label}</h3>
				<div className="mt-1 flex items-center gap-3 text-xs text-text-secondary">
					<span className="flex items-center gap-1">
						<Clock className="size-3" />
						{formatRelativeTime(snapshot.timestamp)}
					</span>
					<span className="flex items-center gap-1">
						<FileText className="size-3" />
						{snapshot.changes.length} {snapshot.changes.length === 1 ? 'file' : 'files'}
					</span>
				</div>
				<Button variant="secondary" size="sm" className="mt-2 w-full" onClick={() => onRevertSnapshot(snapshot.id)} disabled={isReverting}>
					{isReverting ? <Loader2 className="mr-1 size-3 animate-spin" /> : <RotateCcw className="mr-1 size-3" />}
					Revert All Changes
				</Button>
			</div>

			{/* Changed files list */}
			<ScrollArea.Root className="flex-1 overflow-hidden">
				<ScrollArea.Viewport className="size-full">
					<div className="flex flex-col gap-0.5 p-2">
						{snapshot.changes.map((change) => (
							<div
								key={change.path}
								className={`
									group flex items-center justify-between rounded-sm px-2 py-1.5
									hover:bg-bg-tertiary
								`}
							>
								<div className="flex flex-col gap-0.5 overflow-hidden">
									<span className="truncate font-mono text-xs text-text-primary">{change.path}</span>
									<span className={cn('text-xs', ACTION_COLORS[change.action] ?? 'text-text-secondary')}>
										{ACTION_LABELS[change.action] ?? change.action}
									</span>
								</div>
								<Tooltip content={`Revert ${change.path}`}>
									<Button
										variant="ghost"
										size="icon"
										className={`
											size-6 shrink-0 opacity-0
											group-hover:opacity-100
										`}
										onClick={() => onRevertFile(change.path, snapshot.id)}
										disabled={isReverting}
									>
										<RotateCcw className="size-3" />
									</Button>
								</Tooltip>
							</div>
						))}
					</div>
				</ScrollArea.Viewport>
				<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
					<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
				</ScrollArea.Scrollbar>
			</ScrollArea.Root>
		</div>
	);
}
