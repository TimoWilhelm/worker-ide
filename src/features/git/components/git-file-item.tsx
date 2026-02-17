/**
 * Git File Item
 *
 * A single file row in the git status list.
 * Shows file name, directory path, status badge, and action buttons.
 */

import { Minus, Plus, RotateCcw } from 'lucide-react';

import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/utils';

import { getFileName, getDirectoryPath, getStatusDisplay } from '../lib/status-helpers';

import type { GitStatusEntry } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface GitFileItemProperties {
	entry: GitStatusEntry;
	onStage?: (path: string) => void;
	onUnstage?: (path: string) => void;
	onDiscard?: (path: string) => void;
	onClick?: (path: string) => void;
}

// =============================================================================
// Component
// =============================================================================

export function GitFileItem({ entry, onStage, onUnstage, onDiscard, onClick }: GitFileItemProperties) {
	const display = getStatusDisplay(entry.status);
	const fileName = getFileName(entry.path);
	const directoryPath = getDirectoryPath(entry.path);

	return (
		<div
			className={cn('group flex cursor-pointer items-center gap-1.5 py-0.5 pr-2 pl-3 text-sm', 'transition-colors hover:bg-bg-tertiary')}
			onClick={() => onClick?.(entry.path)}
		>
			{/* File name */}
			<span className={cn('min-w-0 truncate', display.fileColorClass)}>{fileName}</span>

			{/* Directory path (dimmed) */}
			{directoryPath && <span className="min-w-0 shrink truncate text-xs text-text-secondary">{directoryPath}</span>}

			{/* Spacer */}
			<span className="flex-1" />

			{/* Action buttons (visible on hover) */}
			<span
				className="
					flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity
					group-hover:opacity-100
				"
			>
				{entry.staged && onUnstage && (
					<Tooltip content="Unstage">
						<button
							type="button"
							onClick={(event) => {
								event.stopPropagation();
								onUnstage(entry.path);
							}}
							className="
								flex size-5 items-center justify-center rounded-sm text-text-secondary
								hover:bg-bg-primary hover:text-text-primary
							"
						>
							<Minus className="size-3" />
						</button>
					</Tooltip>
				)}
				{!entry.staged && onStage && (
					<Tooltip content="Stage">
						<button
							type="button"
							onClick={(event) => {
								event.stopPropagation();
								onStage(entry.path);
							}}
							className="
								flex size-5 items-center justify-center rounded-sm text-text-secondary
								hover:bg-bg-primary hover:text-text-primary
							"
						>
							<Plus className="size-3" />
						</button>
					</Tooltip>
				)}
				{!entry.staged && entry.status !== 'untracked' && onDiscard && (
					<Tooltip content="Discard changes">
						<button
							type="button"
							onClick={(event) => {
								event.stopPropagation();
								onDiscard(entry.path);
							}}
							className="
								flex size-5 items-center justify-center rounded-sm text-text-secondary
								hover:bg-bg-primary hover:text-error
							"
						>
							<RotateCcw className="size-3" />
						</button>
					</Tooltip>
				)}
			</span>

			{/* Status badge */}
			<span className={cn('shrink-0 text-xs font-medium', display.colorClass)}>{display.badge}</span>
		</div>
	);
}
