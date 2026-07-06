import { ArrowRightLeft, Check, ChevronDown, ChevronRight, FileMinus, FilePen, FilePlus, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';

import { Pill } from '@/components/ui/pill';
import { Tooltip } from '@/components/ui/tooltip';
import { computeDiffHunks, groupHunksIntoChanges } from '@/features/editor/lib/diff-decorations';
import { springCritical } from '@/lib/motion-config';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { FileReference } from './file-reference';

import type { FileTargetPosition } from '@/lib/file-target';
import type { PendingFileChange } from '@shared/types';

/**
 * Resolve the editor position of the first diff in a pending change that is
 * attributed to the given agent session. Falls back to the first diff when no
 * session attribution is available.
 */
function getFirstSessionDiffPosition(change: PendingFileChange, sessionId?: string): FileTargetPosition | undefined {
	const groups = groupHunksIntoChanges(computeDiffHunks(change.beforeContent ?? '', change.afterContent ?? ''));
	if (groups.length === 0) {
		return undefined;
	}

	if (sessionId && change.hunkSessionIds) {
		const sessionGroup = groups.find((group) => change.hunkSessionIds?.[group.index]?.includes(sessionId));
		if (sessionGroup) {
			return { line: sessionGroup.startLine, column: 1 };
		}
	}

	return { line: groups[0].startLine, column: 1 };
}

interface ChangedFilesSummaryProperties {
	onApproveChange: (path: string) => void;
	onRejectChange: (path: string) => void;
	onApproveAll: () => void;
	onRejectAll: () => void;
	isReverting: boolean;
	canReject: boolean;
	sessionId?: string;
}

export function ChangedFilesSummary({
	onApproveChange,
	onRejectChange,
	onApproveAll,
	onRejectAll,
	isReverting,
	canReject,
	sessionId,
}: ChangedFilesSummaryProperties) {
	const pendingChanges = useStore((state) => state.pendingChanges);
	const [isExpanded, setIsExpanded] = useState(true);

	// Collect only pending (unresolved) changes, optionally filtered by session
	const pendingEntries = useMemo(() => {
		if (!sessionId) {
			return [];
		}

		const entries: Array<[string, PendingFileChange]> = [];
		for (const [path, change] of pendingChanges) {
			if (change.status === 'pending') {
				if (change.sessionId !== sessionId && !change.sessionIds?.includes(sessionId)) continue;
				entries.push([path, change]);
			}
		}
		return entries;
	}, [pendingChanges, sessionId]);

	if (pendingEntries.length === 0) return;

	return (
		<div className="overflow-hidden rounded-lg border border-accent/25 bg-accent/5">
			<div
				className={cn('flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2', 'text-xs font-medium text-accent transition-colors')}
			>
				<button
					type="button"
					onClick={() => setIsExpanded((previous) => !previous)}
					className="
						-mx-1 flex min-w-0 shrink cursor-pointer items-center gap-2 rounded-md
						px-1
						hover:bg-accent/10
					"
				>
					{isExpanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
					<span className="truncate whitespace-nowrap">
						{pendingEntries.length} file{pendingEntries.length === 1 ? '' : 's'}
					</span>
				</button>
				<div className="ml-auto flex flex-wrap items-center gap-1.5">
					<button
						type="button"
						onClick={() => onApproveAll()}
						disabled={isReverting}
						className={cn(
							'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1',
							'text-2xs font-medium text-success transition-colors',
							'hover:bg-success/10',
							isReverting && 'cursor-not-allowed opacity-50',
						)}
					>
						<Check className="size-3 shrink-0" />
						<span className="whitespace-nowrap">Accept All</span>
					</button>
					<button
						type="button"
						onClick={() => void onRejectAll()}
						disabled={isReverting || !canReject}
						className={cn(
							'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1',
							'text-2xs font-medium text-error transition-colors',
							'hover:bg-error/10',
							(isReverting || !canReject) && 'cursor-not-allowed opacity-50',
						)}
					>
						<X className="size-3 shrink-0" />
						<span className="whitespace-nowrap">Reject All</span>
					</button>
				</div>
			</div>

			{isExpanded && (
				<div className="max-h-40 overflow-y-auto border-t border-accent/15">
					<AnimatePresence initial={false}>
						{pendingEntries.map(([path, change]) => (
							<motion.div
								key={path}
								initial={{ height: 0, opacity: 0 }}
								animate={{ height: 'auto', opacity: 1 }}
								exit={{ height: 0, opacity: 0 }}
								transition={springCritical}
								className="overflow-hidden"
							>
								<ChangedFileRow
									path={path}
									action={change.action}
									hasSnapshot={!!change.snapshotId}
									isActionable={!!change.reviewId}
									onApprove={onApproveChange}
									onReject={onRejectChange}
									isReverting={isReverting}
									position={getFirstSessionDiffPosition(change, sessionId)}
								/>
							</motion.div>
						))}
					</AnimatePresence>
				</div>
			)}
		</div>
	);
}

function ChangedFileRow({
	path,
	action,
	hasSnapshot,
	isActionable,
	onApprove,
	onReject,
	isReverting,
	position,
}: {
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	hasSnapshot: boolean;
	isActionable: boolean;
	onApprove: (path: string) => void;
	onReject: (path: string) => void;
	isReverting: boolean;
	position?: FileTargetPosition;
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
				<div className="min-w-0 truncate">
					<FileReference path={path} className="text-2xs" position={position} />
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<Tooltip content="Accept change">
					<button
						type="button"
						onClick={() => onApprove(path)}
						disabled={isReverting || !isActionable}
						className={cn(
							'inline-flex cursor-pointer items-center rounded-sm p-1',
							'text-text-secondary transition-colors',
							'hover:bg-success/15 hover:text-success',
							(isReverting || !isActionable) && 'cursor-not-allowed opacity-50',
						)}
					>
						<Check className="size-3.5" />
					</button>
				</Tooltip>
				<Tooltip content={isActionable ? (hasSnapshot ? 'Reject change' : 'Waiting for snapshot…') : 'Waiting for review queue…'}>
					<button
						type="button"
						onClick={() => onReject(path)}
						disabled={isReverting || !hasSnapshot || !isActionable}
						className={cn(
							'inline-flex cursor-pointer items-center rounded-sm p-1',
							'text-text-secondary transition-colors',
							'hover:bg-error/15 hover:text-error',
							(isReverting || !hasSnapshot || !isActionable) && 'cursor-not-allowed opacity-50',
						)}
					>
						<X className="size-3.5" />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}

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
