import { describe, expect, it } from 'vitest';

import { computeDiffHunkSessionIds, computeRebasedDiffData, resolveReviewContent } from './review-diff';

describe('resolveReviewContent', () => {
	it('rejects a clean agent hunk while preserving manual edits outside it', () => {
		const result = resolveReviewContent({
			action: 'edit',
			beforeContent: ['one', 'two', 'three'].join('\n'),
			agentAfterContent: ['one', 'TWO', 'three'].join('\n'),
			liveContent: ['human header', 'one', 'TWO', 'three', 'human footer'].join('\n'),
			hunkStatuses: ['rejected'],
			finalizing: true,
		});

		expect(result).toEqual({ action: 'write', content: ['human header', 'one', 'two', 'three', 'human footer'].join('\n') });
	});

	it('preserves manual edits inside a rejected agent hunk', () => {
		const liveContent = ['one', 'TWO with human edit', 'three'].join('\n');
		const result = resolveReviewContent({
			action: 'edit',
			beforeContent: ['one', 'two', 'three'].join('\n'),
			agentAfterContent: ['one', 'TWO', 'three'].join('\n'),
			liveContent,
			hunkStatuses: ['rejected'],
			finalizing: true,
		});

		expect(result).toEqual({ action: 'write', content: liveContent });
	});

	it('deletes a clean rejected create but preserves a manually edited create', () => {
		expect(
			resolveReviewContent({
				action: 'create',
				beforeContent: undefined,
				agentAfterContent: 'agent file',
				liveContent: 'agent file',
				hunkStatuses: ['rejected'],
				finalizing: true,
			}),
		).toEqual({ action: 'delete' });

		expect(
			resolveReviewContent({
				action: 'create',
				beforeContent: undefined,
				agentAfterContent: 'agent file',
				liveContent: 'human edited file',
				hunkStatuses: ['rejected'],
				finalizing: true,
			}),
		).toEqual({ action: 'write', content: 'human edited file' });
	});

	it('preserves manually recreated content when accepting an agent deletion', () => {
		const result = resolveReviewContent({
			action: 'delete',
			beforeContent: 'original file',
			agentAfterContent: undefined,
			liveContent: 'human recreated file',
			hunkStatuses: ['approved'],
			finalizing: true,
		});

		expect(result).toEqual({ action: 'write', content: 'human recreated file' });
	});
});

describe('computeRebasedDiffData', () => {
	it('keeps human-only edits outside agent hunks out of the displayed diff', () => {
		const beforeContent = ['one', 'two', 'three'].join('\n');
		const agentAfterContent = ['one', 'TWO', 'three'].join('\n');
		const liveContent = ['human header', 'one', 'TWO', 'three', 'human footer'].join('\n');

		const diffData = computeRebasedDiffData(beforeContent, agentAfterContent, liveContent);

		expect(diffData?.afterContent).toBe(liveContent);
		expect(diffData?.hunks).toEqual([
			{ type: 'removed', startLine: 3, beforeStartLine: 2, lineCount: 1, lines: ['two'] },
			{ type: 'added', startLine: 3, beforeStartLine: 3, lineCount: 1, lines: ['TWO'] },
		]);
	});

	it('rebases agent hunks after human deletions before the hunk', () => {
		const beforeContent = ['one', 'two', 'three'].join('\n');
		const agentAfterContent = ['one', 'two', 'THREE'].join('\n');
		const liveContent = ['two', 'THREE'].join('\n');

		const diffData = computeRebasedDiffData(beforeContent, agentAfterContent, liveContent);

		expect(diffData?.hunks).toEqual([
			{ type: 'removed', startLine: 2, beforeStartLine: 3, lineCount: 1, lines: ['three'] },
			{ type: 'added', startLine: 2, beforeStartLine: 4, lineCount: 1, lines: ['THREE'] },
		]);
	});
});

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
