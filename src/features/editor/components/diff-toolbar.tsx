/**
 * Diff Toolbar
 *
 * Shown above the code editor when the active file has a pending AI change.
 * Provides file-level accept/reject controls and bulk actions.
 */

import { Check, FileMinus, FilePen, FilePlus, X } from 'lucide-react';

import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface DiffToolbarProperties {
	path: string;
	action: 'create' | 'edit' | 'delete';
	onApprove: (path: string) => void;
	onReject: (path: string) => void;
	onApproveAll: () => void;
	onRejectAll: () => void;
	isReverting: boolean;
	canReject: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function DiffToolbar({
	path,
	action,
	onApprove,
	onReject,
	onApproveAll,
	onRejectAll,
	isReverting,
	canReject,
}: DiffToolbarProperties) {
	return (
		<div className={cn('flex items-center justify-between gap-2 border-b px-3 py-1', 'border-accent/20 bg-accent/5')}>
			{/* Left: file path + action badge */}
			<div className="flex min-w-0 items-center gap-2">
				<ActionIcon action={action} />
				<span className="truncate text-xs font-medium text-text-primary">{path}</span>
				<ActionLabel action={action} />
			</div>

			{/* Right: accept/reject controls */}
			<div className="flex shrink-0 items-center gap-1">
				<button
					type="button"
					onClick={() => onApprove(path)}
					disabled={isReverting}
					className={cn(
						'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5',
						'text-2xs font-medium text-success transition-colors',
						'hover:bg-success/10',
						isReverting && 'cursor-not-allowed opacity-50',
					)}
				>
					<Check className="size-3" />
					Accept
				</button>
				<button
					type="button"
					onClick={() => onReject(path)}
					disabled={isReverting || !canReject}
					className={cn(
						'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5',
						'text-2xs font-medium text-error transition-colors',
						'hover:bg-error/10',
						(isReverting || !canReject) && 'cursor-not-allowed opacity-50',
					)}
				>
					<X className="size-3" />
					Reject
				</button>

				<span className="mx-1 h-3 w-px bg-border" />

				<button
					type="button"
					onClick={onApproveAll}
					disabled={isReverting}
					className={cn(
						'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5',
						'text-2xs font-medium text-text-secondary transition-colors',
						'hover:bg-success/10 hover:text-success',
						isReverting && 'cursor-not-allowed opacity-50',
					)}
				>
					<Check className="size-3" />
					Accept All
				</button>
				<button
					type="button"
					onClick={onRejectAll}
					disabled={isReverting || !canReject}
					className={cn(
						'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5',
						'text-2xs font-medium text-text-secondary transition-colors',
						'hover:bg-error/10 hover:text-error',
						(isReverting || !canReject) && 'cursor-not-allowed opacity-50',
					)}
				>
					<X className="size-3" />
					Reject All
				</button>
			</div>
		</div>
	);
}

// =============================================================================
// Helpers
// =============================================================================

function ActionIcon({ action }: { action: 'create' | 'edit' | 'delete' }) {
	switch (action) {
		case 'create': {
			return <FilePlus className="size-3.5 shrink-0 text-success" />;
		}
		case 'edit': {
			return <FilePen className="size-3.5 shrink-0 text-warning" />;
		}
		case 'delete': {
			return <FileMinus className="size-3.5 shrink-0 text-error" />;
		}
	}
}

function ActionLabel({ action }: { action: 'create' | 'edit' | 'delete' }) {
	const colorClass = action === 'create' ? 'text-success' : action === 'edit' ? 'text-warning' : 'text-error';
	return <span className={cn('text-2xs font-medium', colorClass)}>{action}</span>;
}
