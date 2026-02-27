/**
 * Git Diff Toolbar
 *
 * Shown above the code editor when viewing a read-only git diff.
 * Displays the file path and a close button to dismiss the diff view.
 * Unlike DiffToolbar (AI changes), this has no accept/reject semantics.
 */

import { GitCompareArrows, X } from 'lucide-react';

import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface GitDiffToolbarProperties {
	/** File path being diffed */
	path: string;
	/** Label describing the diff context (e.g., "Working Changes", "abc1234") */
	description?: string;
	/** Called when the user dismisses the diff view */
	onClose: () => void;
}

// =============================================================================
// Component
// =============================================================================

export function GitDiffToolbar({ path, description, onClose }: GitDiffToolbarProperties) {
	return (
		<div className={cn('flex items-center justify-between gap-2 border-b px-3 py-1', 'border-sky-500/20 bg-sky-500/5')}>
			{/* Left: icon + file path + description */}
			<div className="flex min-w-0 items-center gap-2">
				<GitCompareArrows className="size-3.5 shrink-0 text-sky-500" />
				<span className="truncate text-xs font-medium text-text-primary">{path}</span>
				{description && <span className="shrink-0 text-2xs font-medium whitespace-nowrap text-sky-500">{description}</span>}
			</div>

			{/* Right: close button */}
			<button
				type="button"
				onClick={onClose}
				className={cn(
					`
						inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2
						py-0.5
					`,
					'text-2xs font-medium text-text-secondary transition-colors',
					'hover:bg-bg-tertiary hover:text-text-primary',
				)}
			>
				<X className="size-3" />
				Close Diff
			</button>
		</div>
	);
}
