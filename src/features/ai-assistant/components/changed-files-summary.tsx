/**
 * Changed Files Summary
 *
 * Displays a collapsible summary of AI file changes above the chat input.
 * Each file has approve/reject buttons. Bulk actions at the top.
 */

import { ArrowRightLeft, Check, ChevronDown, ChevronRight, FileMinus, FilePen, FilePlus, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { Pill } from '@/components/ui/pill';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { FileReference } from './file-reference';

import type { PendingFileChange } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface ChangedFilesSummaryProperties {
	onApproveChange: (path: string) => void;
	onRejectChange: (path: string) => void;
	onApproveAll: () => void;
	onRejectAll: () => void;
	isReverting: boolean;
	/** Whether any pending change has a snapshot to revert to */
	canReject: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function ChangedFilesSummary({
	onApproveChange,
	onRejectChange,
	onApproveAll,
	onRejectAll,
	isReverting,
	canReject,
}: ChangedFilesSummaryProperties) {
	const pendingChanges = useStore((state) => state.pendingChanges);
	const openFile = useStore((state) => state.openFile);
	const [isExpanded, setIsExpanded] = useState(true);

	// Collect only pending (unresolved) changes
	const pendingEntries = useMemo(() => {
		const entries: Array<[string, PendingFileChange]> = [];
		for (const [path, change] of pendingChanges) {
			if (change.status === 'pending') {
				entries.push([path, change]);
			}
		}
		return entries;
	}, [pendingChanges]);

	const handleFileClick = useCallback(
		(path: string) => {
			openFile(path);
		},
		[openFile],
	);

	if (pendingEntries.length === 0) return;

	return (
		<div className="rounded-lg border border-accent/25 bg-accent/5">
			{/* Header */}
			<button
				type="button"
				onClick={() => setIsExpanded((previous) => !previous)}
				className={cn(
					'flex w-full cursor-pointer items-center justify-between px-3 py-2',
					'text-xs font-medium text-accent transition-colors',
					'hover:bg-accent/10',
				)}
			>
				<div className="flex items-center gap-2">
					{isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
					<span>
						{pendingEntries.length} file{pendingEntries.length === 1 ? '' : 's'}
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onApproveAll();
						}}
						disabled={isReverting}
						className={cn(
							'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5',
							'text-2xs font-medium text-success transition-colors',
							'hover:bg-success/10',
							isReverting && 'cursor-not-allowed opacity-50',
						)}
					>
						<Check className="size-3" />
						<span className="whitespace-nowrap">Accept All</span>
					</button>
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							void onRejectAll();
						}}
						disabled={isReverting || !canReject}
						className={cn(
							'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5',
							'text-2xs font-medium text-error transition-colors',
							'hover:bg-error/10',
							(isReverting || !canReject) && 'cursor-not-allowed opacity-50',
						)}
					>
						<X className="size-3" />
						<span className="whitespace-nowrap">Reject All</span>
					</button>
				</div>
			</button>

			{/* File list */}
			{isExpanded && (
				<div className="max-h-40 overflow-y-auto border-t border-accent/15">
					{pendingEntries.map(([path, change]) => (
						<ChangedFileRow
							key={path}
							path={path}
							action={change.action}
							hasSnapshot={!!change.snapshotId}
							onFileClick={handleFileClick}
							onApprove={onApproveChange}
							onReject={onRejectChange}
							isReverting={isReverting}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// =============================================================================
// File Row
// =============================================================================

function ChangedFileRow({
	path,
	action,
	hasSnapshot,
	onFileClick,
	onApprove,
	onReject,
	isReverting,
}: {
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	hasSnapshot: boolean;
	onFileClick: (path: string) => void;
	onApprove: (path: string) => void;
	onReject: (path: string) => void;
	isReverting: boolean;
}) {
	return (
		<div
			className={cn(
				'flex items-center justify-between gap-2 px-3 py-1.5',
				`
					transition-colors
					hover:bg-accent/5
				`,
			)}
		>
			<div className="flex min-w-0 items-center gap-2">
				<ActionBadge action={action} />
				<button type="button" onClick={() => onFileClick(path)} className="min-w-0 cursor-pointer truncate">
					<FileReference path={path} className="text-2xs" />
				</button>
			</div>
			<div className="flex shrink-0 items-center gap-0.5">
				<button
					type="button"
					onClick={() => onApprove(path)}
					disabled={isReverting}
					title="Accept change"
					className={cn(
						'inline-flex cursor-pointer items-center rounded-sm p-0.5',
						'text-text-secondary transition-colors',
						'hover:bg-success/15 hover:text-success',
						isReverting && 'cursor-not-allowed opacity-50',
					)}
				>
					<Check className="size-3.5" />
				</button>
				<button
					type="button"
					onClick={() => onReject(path)}
					disabled={isReverting || !hasSnapshot}
					title={hasSnapshot ? 'Reject change' : 'Waiting for snapshot…'}
					className={cn(
						'inline-flex cursor-pointer items-center rounded-sm p-0.5',
						'text-text-secondary transition-colors',
						'hover:bg-error/15 hover:text-error',
						(isReverting || !hasSnapshot) && 'cursor-not-allowed opacity-50',
					)}
				>
					<X className="size-3.5" />
				</button>
			</div>
		</div>
	);
}

// =============================================================================
// Action Badge
// =============================================================================

const ACTION_BADGE_CONFIG: Record<
	'create' | 'edit' | 'delete' | 'move',
	{ icon: typeof FilePlus; color: 'success' | 'warning' | 'error' | 'sky' }
> = {
	create: { icon: FilePlus, color: 'success' },
	edit: { icon: FilePen, color: 'warning' },
	delete: { icon: FileMinus, color: 'error' },
	move: { icon: ArrowRightLeft, color: 'sky' },
};

function ActionBadge({ action }: { action: 'create' | 'edit' | 'delete' | 'move' }) {
	const { icon: Icon, color } = ACTION_BADGE_CONFIG[action];
	return (
		<Pill size="xs" rounded="sm" color={color}>
			<Icon className="size-3" />
		</Pill>
	);
}
