/**
 * Unit tests for git status helper utilities.
 */

import { describe, expect, it } from 'vitest';

import { countChangedFiles, getDirectoryPath, getFileName, getStatusDisplay, groupStatusEntries, isStagedStatus } from './status-helpers';

import type { GitFileStatus, GitStatusEntry } from '@shared/types';

// =============================================================================
// Helpers
// =============================================================================

function makeEntry(path: string, status: GitFileStatus, staged = false): GitStatusEntry {
	return {
		path,
		status,
		staged,
		headStatus: 0,
		workdirStatus: 0,
		stageStatus: 0,
	};
}

// =============================================================================
// getStatusDisplay
// =============================================================================

describe('getStatusDisplay', () => {
	it('returns correct display for untracked files', () => {
		const display = getStatusDisplay('untracked');
		expect(display.badge).toBe('U');
		expect(display.label).toBe('Untracked');
		expect(display.colorClass).toContain('emerald');
	});

	it('returns correct display for modified files', () => {
		const display = getStatusDisplay('modified');
		expect(display.badge).toBe('M');
		expect(display.label).toBe('Modified');
		expect(display.colorClass).toContain('sky');
	});

	it('returns correct display for deleted files', () => {
		const display = getStatusDisplay('deleted');
		expect(display.badge).toBe('D');
		expect(display.label).toBe('Deleted');
		expect(display.colorClass).toContain('red');
	});

	it('returns correct display for staged additions', () => {
		const display = getStatusDisplay('untracked-staged');
		expect(display.badge).toBe('A');
		expect(display.label).toBe('Added');
		expect(display.colorClass).toContain('emerald');
	});

	it('returns empty badge for unmodified files', () => {
		const display = getStatusDisplay('unmodified');
		expect(display.badge).toBe('');
	});

	it('returns display for all statuses', () => {
		const allStatuses: GitFileStatus[] = [
			'untracked',
			'untracked-staged',
			'untracked-partially-staged',
			'unmodified',
			'modified',
			'modified-staged',
			'modified-partially-staged',
			'deleted',
			'deleted-staged',
		];

		for (const status of allStatuses) {
			const display = getStatusDisplay(status);
			expect(display).toBeDefined();
			expect(display.label).toBeTruthy();
			expect(display.colorClass).toBeTruthy();
			expect(display.fileColorClass).toBeTruthy();
		}
	});
});

// =============================================================================
// groupStatusEntries
// =============================================================================

describe('groupStatusEntries', () => {
	it('groups entries into staged, unstaged, and untracked', () => {
		const entries: GitStatusEntry[] = [
			makeEntry('src/main.ts', 'modified-staged', true),
			makeEntry('src/app.tsx', 'modified'),
			makeEntry('new-file.txt', 'untracked'),
			makeEntry('package.json', 'unmodified'),
		];

		const groups = groupStatusEntries(entries);
		expect(groups.staged).toHaveLength(1);
		expect(groups.staged[0].path).toBe('src/main.ts');
		expect(groups.unstaged).toHaveLength(1);
		expect(groups.unstaged[0].path).toBe('src/app.tsx');
		expect(groups.untracked).toHaveLength(1);
		expect(groups.untracked[0].path).toBe('new-file.txt');
	});

	it('excludes unmodified entries', () => {
		const entries: GitStatusEntry[] = [makeEntry('clean-file.ts', 'unmodified'), makeEntry('another-clean.ts', 'unmodified')];

		const groups = groupStatusEntries(entries);
		expect(groups.staged).toHaveLength(0);
		expect(groups.unstaged).toHaveLength(0);
		expect(groups.untracked).toHaveLength(0);
	});

	it('handles empty input', () => {
		const groups = groupStatusEntries([]);
		expect(groups.staged).toHaveLength(0);
		expect(groups.unstaged).toHaveLength(0);
		expect(groups.untracked).toHaveLength(0);
	});

	it('handles multiple staged entries', () => {
		const entries: GitStatusEntry[] = [
			makeEntry('a.ts', 'modified-staged', true),
			makeEntry('b.ts', 'deleted-staged', true),
			makeEntry('c.ts', 'untracked-staged', true),
		];

		const groups = groupStatusEntries(entries);
		expect(groups.staged).toHaveLength(3);
		expect(groups.unstaged).toHaveLength(0);
		expect(groups.untracked).toHaveLength(0);
	});
});

// =============================================================================
// countChangedFiles
// =============================================================================

describe('countChangedFiles', () => {
	it('counts non-unmodified entries', () => {
		const entries: GitStatusEntry[] = [
			makeEntry('a.ts', 'modified'),
			makeEntry('b.ts', 'unmodified'),
			makeEntry('c.ts', 'untracked'),
			makeEntry('d.ts', 'deleted'),
		];

		expect(countChangedFiles(entries)).toBe(3);
	});

	it('returns 0 for empty array', () => {
		expect(countChangedFiles([])).toBe(0);
	});

	it('returns 0 when all files are unmodified', () => {
		const entries: GitStatusEntry[] = [makeEntry('a.ts', 'unmodified'), makeEntry('b.ts', 'unmodified')];

		expect(countChangedFiles(entries)).toBe(0);
	});
});

// =============================================================================
// isStagedStatus
// =============================================================================

describe('isStagedStatus', () => {
	it('returns true for staged statuses', () => {
		expect(isStagedStatus('untracked-staged')).toBe(true);
		expect(isStagedStatus('untracked-partially-staged')).toBe(true);
		expect(isStagedStatus('modified-staged')).toBe(true);
		expect(isStagedStatus('modified-partially-staged')).toBe(true);
		expect(isStagedStatus('deleted-staged')).toBe(true);
	});

	it('returns false for non-staged statuses', () => {
		expect(isStagedStatus('untracked')).toBe(false);
		expect(isStagedStatus('modified')).toBe(false);
		expect(isStagedStatus('deleted')).toBe(false);
		expect(isStagedStatus('unmodified')).toBe(false);
	});
});

// =============================================================================
// getFileName
// =============================================================================

describe('getFileName', () => {
	it('extracts file name from path', () => {
		expect(getFileName('src/components/button.tsx')).toBe('button.tsx');
	});

	it('returns the full string for root-level files', () => {
		expect(getFileName('package.json')).toBe('package.json');
	});

	it('handles deeply nested paths', () => {
		expect(getFileName('a/b/c/d/e.ts')).toBe('e.ts');
	});
});

// =============================================================================
// getDirectoryPath
// =============================================================================

describe('getDirectoryPath', () => {
	it('extracts directory from path', () => {
		expect(getDirectoryPath('src/components/button.tsx')).toBe('src/components');
	});

	it('returns empty string for root-level files', () => {
		expect(getDirectoryPath('package.json')).toBe('');
	});

	it('handles deeply nested paths', () => {
		expect(getDirectoryPath('a/b/c/d/e.ts')).toBe('a/b/c/d');
	});
});
