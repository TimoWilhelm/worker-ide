/**
 * Unit tests for git graph layout engine.
 */

import { describe, expect, it } from 'vitest';

import { COLUMN_WIDTH, COMMIT_RADIUS, ROW_HEIGHT, computeGraphLayout, getMaxColumns } from './git-graph-layout';

import type { GitCommitEntry } from '@shared/types';

// =============================================================================
// Helpers
// =============================================================================

function makeCommit(objectId: string, parentObjectIds: string[] = [], message = `commit ${objectId}`): GitCommitEntry {
	return {
		objectId,
		abbreviatedObjectId: objectId.slice(0, 7),
		message,
		author: { name: 'Test', email: 'test@example.com', timestamp: Date.now() },
		parentObjectIds,
	};
}

// =============================================================================
// Constants
// =============================================================================

describe('layout constants', () => {
	it('exports expected constants', () => {
		expect(COLUMN_WIDTH).toBeGreaterThan(0);
		expect(ROW_HEIGHT).toBeGreaterThan(0);
		expect(COMMIT_RADIUS).toBeGreaterThan(0);
	});
});

// =============================================================================
// computeGraphLayout — linear history
// =============================================================================

describe('computeGraphLayout — linear history', () => {
	it('handles empty commit list', () => {
		const result = computeGraphLayout({ commits: [] });
		expect(result).toEqual([]);
	});

	it('places a single root commit in column 0', () => {
		const commits = [makeCommit('aaa')];
		const result = computeGraphLayout({ commits });

		expect(result).toHaveLength(1);
		expect(result[0].column).toBe(0);
		expect(result[0].connections).toHaveLength(0);
	});

	it('places a linear chain in column 0', () => {
		const commits = [makeCommit('ccc', ['bbb']), makeCommit('bbb', ['aaa']), makeCommit('aaa')];
		const result = computeGraphLayout({ commits });

		expect(result).toHaveLength(3);
		for (const entry of result) {
			expect(entry.column).toBe(0);
		}
	});

	it('creates connections between parent/child in linear chain', () => {
		const commits = [makeCommit('bbb', ['aaa']), makeCommit('aaa')];
		const result = computeGraphLayout({ commits });

		// First commit (bbb) should have a connection from col 0 to col 0
		expect(result[0].connections).toHaveLength(1);
		expect(result[0].connections[0].fromColumn).toBe(0);
		expect(result[0].connections[0].toColumn).toBe(0);
	});
});

// =============================================================================
// computeGraphLayout — branching
// =============================================================================

describe('computeGraphLayout — branching', () => {
	it('allocates a second column for a branch', () => {
		// History: merge commit with two parents, then each parent
		const commits = [
			makeCommit('merge', ['parent1', 'parent2']),
			makeCommit('parent1', ['base']),
			makeCommit('parent2', ['base']),
			makeCommit('base'),
		];
		const result = computeGraphLayout({ commits });

		expect(result).toHaveLength(4);
		// Merge commit should be in column 0
		expect(result[0].column).toBe(0);
		// First parent continues in column 0
		expect(result[1].column).toBe(0);
		// Second parent should be in a different column
		expect(result[2].column).toBeGreaterThanOrEqual(1);
	});

	it('merges lanes back when branches converge', () => {
		const commits = [
			makeCommit('merge', ['left', 'right']),
			makeCommit('left', ['base']),
			makeCommit('right', ['base']),
			makeCommit('base'),
		];
		const result = computeGraphLayout({ commits });

		// Base commit should merge the two lanes back
		const baseEntry = result[3];
		expect(baseEntry.column).toBeDefined();
	});
});

// =============================================================================
// computeGraphLayout — ref labels
// =============================================================================

describe('computeGraphLayout — ref labels', () => {
	it('attaches current branch name to HEAD commit', () => {
		const commits = [makeCommit('head', ['prev']), makeCommit('prev')];
		const branches = [{ name: 'main', isCurrent: true }];
		const result = computeGraphLayout({ commits, branches });

		expect(result[0].branchNames).toContain('main');
		expect(result[1].branchNames).toHaveLength(0);
	});

	it('attaches tag names via oid', () => {
		const commits = [makeCommit('tagged', ['prev']), makeCommit('prev')];
		const tags = ['v1.0:tagged'];
		const result = computeGraphLayout({ commits, tags });

		expect(result[0].tagNames).toContain('v1.0');
		expect(result[1].tagNames).toHaveLength(0);
	});

	it('handles tags with no matching commit', () => {
		const commits = [makeCommit('aaa')];
		const tags = ['v1.0:nonexistent'];
		const result = computeGraphLayout({ commits, tags });

		expect(result[0].tagNames).toHaveLength(0);
	});
});

// =============================================================================
// getMaxColumns
// =============================================================================

describe('getMaxColumns', () => {
	it('returns 0 for empty array', () => {
		expect(getMaxColumns([])).toBe(0);
	});

	it('returns 1 for a single-column graph', () => {
		const entries = computeGraphLayout({
			commits: [makeCommit('aaa')],
		});
		expect(getMaxColumns(entries)).toBe(1);
	});

	it('returns correct count for branching graph', () => {
		const commits = [
			makeCommit('merge', ['left', 'right']),
			makeCommit('left', ['base']),
			makeCommit('right', ['base']),
			makeCommit('base'),
		];
		const entries = computeGraphLayout({ commits });
		expect(getMaxColumns(entries)).toBeGreaterThanOrEqual(2);
	});
});
