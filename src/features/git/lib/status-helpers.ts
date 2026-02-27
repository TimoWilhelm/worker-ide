/**
 * Git status helper utilities.
 *
 * Maps git file statuses to display labels, colors, and icons
 * for use in the Git UI.
 */

import type { GitFileStatus, GitStatusEntry } from '@shared/types';

// =============================================================================
// Status Display Mapping
// =============================================================================

interface StatusDisplay {
	/** Short label shown next to file names (e.g. "M", "U", "D") */
	badge: string;
	/** Full human-readable label (e.g. "Modified", "Untracked") */
	label: string;
	/** Tailwind text color class for the badge/label */
	colorClass: string;
	/** Tailwind text color class for the file name in the tree */
	fileColorClass: string;
}

const STATUS_DISPLAY_MAP: Record<GitFileStatus, StatusDisplay> = {
	untracked: {
		badge: 'U',
		label: 'Untracked',
		colorClass: 'text-emerald-400',
		fileColorClass: 'text-emerald-400',
	},
	'untracked-staged': {
		badge: 'A',
		label: 'Added',
		colorClass: 'text-emerald-400',
		fileColorClass: 'text-emerald-400',
	},
	'untracked-partially-staged': {
		badge: 'A',
		label: 'Added (partial)',
		colorClass: 'text-emerald-400',
		fileColorClass: 'text-emerald-400',
	},
	unmodified: {
		badge: '',
		label: 'Unmodified',
		colorClass: 'text-zinc-500',
		fileColorClass: 'text-zinc-400',
	},
	modified: {
		badge: 'M',
		label: 'Modified',
		colorClass: 'text-sky-400',
		fileColorClass: 'text-sky-400',
	},
	'modified-staged': {
		badge: 'M',
		label: 'Modified',
		colorClass: 'text-sky-400',
		fileColorClass: 'text-sky-400',
	},
	'modified-partially-staged': {
		badge: 'M',
		label: 'Modified (partial)',
		colorClass: 'text-sky-400',
		fileColorClass: 'text-sky-400',
	},
	deleted: {
		badge: 'D',
		label: 'Deleted',
		colorClass: 'text-red-400',
		fileColorClass: 'text-red-400',
	},
	'deleted-staged': {
		badge: 'D',
		label: 'Deleted',
		colorClass: 'text-red-400',
		fileColorClass: 'text-red-400',
	},
};

/**
 * Get display info (badge, label, colors) for a git file status.
 */
export function getStatusDisplay(status: GitFileStatus): StatusDisplay {
	return STATUS_DISPLAY_MAP[status];
}

// =============================================================================
// Status Grouping
// =============================================================================

export interface StatusGroups {
	staged: GitStatusEntry[];
	unstaged: GitStatusEntry[];
	untracked: GitStatusEntry[];
}

/**
 * Group git status entries into staged, unstaged, and untracked buckets.
 * Entries with status "unmodified" are excluded.
 */
export function groupStatusEntries(entries: ReadonlyArray<GitStatusEntry>): StatusGroups {
	const staged: GitStatusEntry[] = [];
	const unstaged: GitStatusEntry[] = [];
	const untracked: GitStatusEntry[] = [];

	for (const entry of entries) {
		if (entry.status === 'unmodified') {
			continue;
		}

		if (entry.status === 'untracked') {
			untracked.push(entry);
		} else if (entry.staged) {
			staged.push(entry);
		} else {
			unstaged.push(entry);
		}
	}

	return { staged, unstaged, untracked };
}

/**
 * Count the total number of changed files (excludes unmodified).
 */
export function countChangedFiles(entries: ReadonlyArray<GitStatusEntry>): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.status !== 'unmodified') {
			count += 1;
		}
	}
	return count;
}

/**
 * Check if a file status represents a staged change.
 */
export function isStagedStatus(status: GitFileStatus): boolean {
	return (
		status === 'untracked-staged' ||
		status === 'untracked-partially-staged' ||
		status === 'modified-staged' ||
		status === 'modified-partially-staged' ||
		status === 'deleted-staged'
	);
}

/**
 * Extract the file name from a full path.
 */
export function getFileName(filePath: string): string {
	const lastSlash = filePath.lastIndexOf('/');
	return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
}

/**
 * Extract the directory path from a full file path.
 * Returns empty string for root-level files.
 */
export function getDirectoryPath(filePath: string): string {
	const lastSlash = filePath.lastIndexOf('/');
	return lastSlash === -1 ? '' : filePath.slice(0, lastSlash);
}
