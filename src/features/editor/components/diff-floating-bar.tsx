/**
 * Diff Floating Bar
 *
 * Floating UI element at the bottom of the editor when a file has pending AI changes.
 * Provides hunk-level navigation (prev/next), a counter ("3 of 12 edits"),
 * and file-level Accept All / Reject All controls.
 */

import { Check, ChevronDown, ChevronUp, X } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { ChangeGroup } from '../lib/diff-decorations';

// =============================================================================
// Types
// =============================================================================

export interface DiffFloatingBarProperties {
	/** Change groups derived from the diff hunks */
	changeGroups: ChangeGroup[];
	/** Per-group statuses for showing resolved state */
	hunkStatuses: Array<'pending' | 'approved' | 'rejected'>;
	/** Index of the currently focused change group (0-based) */
	currentGroupIndex: number;
	/** Called when the user navigates to a different change group */
	onNavigate: (groupIndex: number) => void;
	/** Called to accept all pending changes */
	onAcceptAll: (path: string) => void;
	/** Called to reject all pending changes */
	onRejectAll: (path: string) => void;
	/** File path for accept/reject callbacks */
	path: string;
	/** Whether a revert operation is in progress */
	isReverting: boolean;
	/** Whether rejection is possible */
	canReject: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function DiffFloatingBar({
	changeGroups,
	hunkStatuses,
	currentGroupIndex,
	onNavigate,
	onAcceptAll,
	onRejectAll,
	path,
	isReverting,
	canReject,
}: DiffFloatingBarProperties) {
	const totalGroups = changeGroups.length;
	const pendingCount = hunkStatuses.filter((status) => status === 'pending').length;

	if (totalGroups === 0) return;

	const displayIndex = Math.min(currentGroupIndex + 1, totalGroups);

	const handlePrevious = () => {
		if (currentGroupIndex > 0) {
			onNavigate(currentGroupIndex - 1);
		}
	};

	const handleNext = () => {
		if (currentGroupIndex < totalGroups - 1) {
			onNavigate(currentGroupIndex + 1);
		}
	};

	return (
		<div
			data-diff-floating-bar
			className={cn(
				`
					absolute bottom-3 left-1/2 z-10 -translate-x-1/2 transition-[bottom]
					duration-150
				`,
				'flex items-center gap-1 rounded-lg border px-1.5 py-1',
				'border-border-solid bg-bg-secondary shadow-lg',
				'animate-fade-in',
			)}
		>
			{/* Navigation controls */}
			<button
				type="button"
				onClick={handlePrevious}
				disabled={currentGroupIndex <= 0}
				className={cn(
					'inline-flex cursor-pointer items-center justify-center rounded-md p-1',
					'text-text-secondary transition-colors',
					'hover:bg-bg-tertiary hover:text-text-primary',
					'disabled:cursor-not-allowed disabled:opacity-30',
				)}
				aria-label="Previous edit"
			>
				<ChevronUp className="size-3.5" />
			</button>

			<span
				className="
					px-1 text-2xs font-medium whitespace-nowrap text-text-secondary select-none
				"
			>
				{displayIndex} of {totalGroups} edits
				{pendingCount < totalGroups && <span className="text-text-secondary/60"> ({pendingCount} pending)</span>}
			</span>

			<button
				type="button"
				onClick={handleNext}
				disabled={currentGroupIndex >= totalGroups - 1}
				className={cn(
					'inline-flex cursor-pointer items-center justify-center rounded-md p-1',
					'text-text-secondary transition-colors',
					'hover:bg-bg-tertiary hover:text-text-primary',
					'disabled:cursor-not-allowed disabled:opacity-30',
				)}
				aria-label="Next edit"
			>
				<ChevronDown className="size-3.5" />
			</button>

			{/* Divider */}
			<div className="mx-0.5 h-4 w-px bg-border-solid" />

			{/* Accept All */}
			<button
				type="button"
				onClick={() => onAcceptAll(path)}
				disabled={isReverting || pendingCount === 0}
				className={cn(
					'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5',
					'text-2xs font-medium text-success transition-colors',
					'hover:bg-success/10',
					(isReverting || pendingCount === 0) && 'cursor-not-allowed opacity-50',
				)}
			>
				<Check className="size-3" />
				Accept
			</button>

			{/* Reject All */}
			<button
				type="button"
				onClick={() => onRejectAll(path)}
				disabled={isReverting || !canReject || pendingCount === 0}
				className={cn(
					'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5',
					'text-2xs font-medium text-error transition-colors',
					'hover:bg-error/10',
					(isReverting || !canReject || pendingCount === 0) && 'cursor-not-allowed opacity-50',
				)}
			>
				<X className="size-3" />
				Reject
			</button>
		</div>
	);
}
