import { describe, expect, it } from 'vitest';

import { computeDiffHunkSessionIds } from './review-diff';

describe('computeDiffHunkSessionIds', () => {
	it('attributes separate hunks to the matching sessions', () => {
		const hunkSessionIds = computeDiffHunkSessionIds(
			['alpha', 'beta', 'gamma'].join('\n'),
			['ALPHA', 'beta', 'GAMMA'].join('\n'),
			[
				{ sessionId: 'session-a', afterContent: ['ALPHA', 'beta', 'gamma'].join('\n') },
				{ sessionId: 'session-b', afterContent: ['ALPHA', 'beta', 'GAMMA'].join('\n') },
			],
			'session-b',
		);

		expect(hunkSessionIds).toEqual([['session-a'], ['session-b']]);
	});

	it('retains lineage when a later session deletes an earlier replacement', () => {
		const hunkSessionIds = computeDiffHunkSessionIds(
			['alpha', 'beta'].join('\n'),
			'beta',
			[
				{ sessionId: 'session-a', afterContent: ['ALPHA', 'beta'].join('\n') },
				{ sessionId: 'session-b', afterContent: 'beta' },
			],
			'session-b',
		);

		expect(hunkSessionIds).toEqual([['session-a', 'session-b']]);
	});

	it('falls back to the latest session when the step sequence is incomplete', () => {
		const hunkSessionIds = computeDiffHunkSessionIds('alpha', 'ALPHA', [], 'session-z');

		expect(hunkSessionIds).toEqual([['session-z']]);
	});
});
