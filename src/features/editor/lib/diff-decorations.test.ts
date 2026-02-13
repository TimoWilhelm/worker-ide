/**
 * Tests for diff computation utility.
 */

import { describe, expect, it } from 'vitest';

import { computeDiffData, computeDiffHunks } from './diff-decorations';

describe('computeDiffHunks', () => {
	it('returns empty array for identical content', () => {
		const hunks = computeDiffHunks('hello\nworld\n', 'hello\nworld\n');
		expect(hunks).toEqual([]);
	});

	it('detects added lines', () => {
		const hunks = computeDiffHunks('line1\n', 'line1\nline2\n');
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe('added');
		expect(hunks[0].lines).toEqual(['line2']);
	});

	it('detects removed lines', () => {
		const hunks = computeDiffHunks('line1\nline2\n', 'line1\n');
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe('removed');
		expect(hunks[0].lines).toEqual(['line2']);
	});

	it('detects both added and removed lines', () => {
		const hunks = computeDiffHunks('aaa\nbbb\nccc\n', 'aaa\nxxx\nccc\n');
		const removed = hunks.filter((h) => h.type === 'removed');
		const added = hunks.filter((h) => h.type === 'added');
		expect(removed.length).toBeGreaterThanOrEqual(1);
		expect(added.length).toBeGreaterThanOrEqual(1);
	});

	it('handles empty before content (new file)', () => {
		const hunks = computeDiffHunks('', 'line1\nline2\n');
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe('added');
		expect(hunks[0].lines).toEqual(['line1', 'line2']);
	});

	it('handles empty after content (deleted file)', () => {
		const hunks = computeDiffHunks('line1\nline2\n', '');
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe('removed');
		expect(hunks[0].lines).toEqual(['line1', 'line2']);
	});

	it('assigns correct startLine for added hunks', () => {
		const hunks = computeDiffHunks('a\nb\n', 'a\nx\nb\n');
		const added = hunks.find((h) => h.type === 'added');
		expect(added).toBeDefined();
		expect(added?.startLine).toBe(2);
	});
});

describe('computeDiffData', () => {
	it('returns undefined for identical content', () => {
		expect(computeDiffData('same', 'same')).toBeUndefined();
	});

	it('returns undefined for both empty', () => {
		expect(computeDiffData('', '')).toBeUndefined();
	});

	it('returns DiffData for different content', () => {
		const result = computeDiffData('old\n', 'new\n');
		expect(result).toBeDefined();
		expect(result?.hunks.length).toBeGreaterThan(0);
		expect(result?.beforeContent).toBe('old\n');
		expect(result?.afterContent).toBe('new\n');
	});

	it('handles undefined inputs as empty strings', () => {
		const result = computeDiffData(undefined, 'new content\n');
		expect(result).toBeDefined();
		expect(result?.hunks.length).toBeGreaterThan(0);
	});
});
