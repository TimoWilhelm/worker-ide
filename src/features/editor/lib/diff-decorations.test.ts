/**
 * Tests for diff computation utility.
 */

import { describe, expect, it } from 'vitest';

import { computeDiffData, computeDiffHunks, groupHunksIntoChanges, reconstructContent } from './diff-decorations';

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

	it('assigns correct beforeStartLine for removed hunks', () => {
		const hunks = computeDiffHunks('a\nb\nc\n', 'a\nc\n');
		const removed = hunks.find((h) => h.type === 'removed');
		expect(removed).toBeDefined();
		expect(removed?.beforeStartLine).toBe(2);
		expect(removed?.startLine).toBe(2);
	});

	it('assigns correct beforeStartLine for added hunks', () => {
		const hunks = computeDiffHunks('a\nc\n', 'a\nb\nc\n');
		const added = hunks.find((h) => h.type === 'added');
		expect(added).toBeDefined();
		expect(added?.startLine).toBe(2);
		expect(added?.beforeStartLine).toBe(2);
	});

	it('tracks before and after line numbers through a replacement', () => {
		// Replace line 2 ("b") with "X","Y" — 1 removed, 2 added
		const hunks = computeDiffHunks('a\nb\nc\n', 'a\nX\nY\nc\n');
		const removed = hunks.find((h) => h.type === 'removed');
		const added = hunks.find((h) => h.type === 'added');
		expect(removed).toBeDefined();
		expect(added).toBeDefined();
		// Removed hunk: "b" was at before-line 2, attached to after-line 2
		expect(removed?.beforeStartLine).toBe(2);
		expect(removed?.startLine).toBe(2);
		// Added hunk: "X","Y" start at after-line 2, before-line has advanced past removed
		expect(added?.startLine).toBe(2);
		expect(added?.beforeStartLine).toBe(3);
	});

	it('assigns correct beforeStartLine for single-line change at line 1', () => {
		const hunks = computeDiffHunks('import {foo} from "bar"\nconst x = 1;\n', 'import { foo } from "bar";\nconst x = 1;\n');
		const removed = hunks.find((h) => h.type === 'removed');
		const added = hunks.find((h) => h.type === 'added');
		expect(removed).toBeDefined();
		expect(added).toBeDefined();
		expect(removed?.beforeStartLine).toBe(1);
		expect(removed?.startLine).toBe(1);
		expect(added?.startLine).toBe(1);
	});

	it('tracks line numbers correctly when multiple hunks exist', () => {
		// Lines 2 and 4 are changed
		const hunks = computeDiffHunks('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n');
		const removedHunks = hunks.filter((h) => h.type === 'removed');
		const addedHunks = hunks.filter((h) => h.type === 'added');
		expect(removedHunks).toHaveLength(2);
		expect(addedHunks).toHaveLength(2);
		// First change: line 2
		expect(removedHunks[0].beforeStartLine).toBe(2);
		expect(removedHunks[0].startLine).toBe(2);
		expect(addedHunks[0].startLine).toBe(2);
		// Second change: line 4
		expect(removedHunks[1].beforeStartLine).toBe(4);
		expect(removedHunks[1].startLine).toBe(4);
		expect(addedHunks[1].startLine).toBe(4);
	});
});

describe('computeDiffHunks — trailing newline normalisation', () => {
	it('produces no hunks when only a trailing newline is added', () => {
		const hunks = computeDiffHunks('a\nb\nc', 'a\nb\nc\n');
		expect(hunks).toEqual([]);
	});

	it('produces no hunks when only a trailing newline is removed', () => {
		const hunks = computeDiffHunks('a\nb\nc\n', 'a\nb\nc');
		expect(hunks).toEqual([]);
	});

	it('still detects real changes when trailing newline also changes', () => {
		// Before has no trailing newline; after adds semicolons and trailing newline
		const hunks = computeDiffHunks('const x = 1\nconst y = 2', 'const x = 1;\nconst y = 2;\n');
		const removed = hunks.filter((h) => h.type === 'removed');
		const added = hunks.filter((h) => h.type === 'added');
		expect(removed.length).toBeGreaterThanOrEqual(1);
		expect(added.length).toBeGreaterThanOrEqual(1);
		// The added lines should contain the semicolon versions
		const addedLines = added.flatMap((h) => h.lines);
		expect(addedLines).toContain('const x = 1;');
		expect(addedLines).toContain('const y = 2;');
	});

	it('detects an intentional blank line added between content lines', () => {
		const hunks = computeDiffHunks('a\nb\nc\n', 'a\nb\n\nc\n');
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe('added');
		expect(hunks[0].lines).toEqual(['']);
		expect(hunks[0].startLine).toBe(3);
	});

	it('detects an intentional blank line added at the end (double newline)', () => {
		const hunks = computeDiffHunks('a\nb\n', 'a\nb\n\n');
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe('added');
		expect(hunks[0].lines).toEqual(['']);
	});

	it('detects a removed blank line', () => {
		const hunks = computeDiffHunks('a\n\nb\n', 'a\nb\n');
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe('removed');
		expect(hunks[0].lines).toEqual(['']);
	});

	it('detects a new line of code added at the end regardless of trailing newline', () => {
		// Before has no trailing newline, after adds a line AND trailing newline
		const hunks = computeDiffHunks('a\nb', 'a\nb\nc\n');
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe('added');
		expect(hunks[0].lines).toEqual(['c']);
		expect(hunks[0].startLine).toBe(3);
	});

	it('detects a new line of code added at the end without trailing newline change', () => {
		// Both lack trailing newline; a real line is added
		const hunks = computeDiffHunks('a\nb', 'a\nb\nc');
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe('added');
		expect(hunks[0].lines).toEqual(['c']);
		expect(hunks[0].startLine).toBe(3);
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

	it('returns undefined when only trailing newline differs', () => {
		expect(computeDiffData('a\nb\nc', 'a\nb\nc\n')).toBeUndefined();
		expect(computeDiffData('a\nb\nc\n', 'a\nb\nc')).toBeUndefined();
	});

	it('preserves original beforeContent and afterContent in returned DiffData', () => {
		// Even though normalisation happens internally, the returned DiffData
		// stores the original (un-normalised) strings so that callers can
		// use them as-is (e.g. for accept/reject logic).
		const result = computeDiffData('a\nb', 'a\nB');
		expect(result).toBeDefined();
		expect(result?.beforeContent).toBe('a\nb');
		expect(result?.afterContent).toBe('a\nB');
	});
});

// =============================================================================
// groupHunksIntoChanges
// =============================================================================

describe('groupHunksIntoChanges', () => {
	it('returns empty array for empty hunks', () => {
		expect(groupHunksIntoChanges([])).toEqual([]);
	});

	it('groups a single added hunk as one change', () => {
		const hunks = computeDiffHunks('a\n', 'a\nb\n');
		const groups = groupHunksIntoChanges(hunks);
		expect(groups).toHaveLength(1);
		expect(groups[0].index).toBe(0);
		expect(groups[0].hunks).toHaveLength(1);
		expect(groups[0].hunks[0].type).toBe('added');
	});

	it('groups a single removed hunk as one change', () => {
		const hunks = computeDiffHunks('a\nb\n', 'a\n');
		const groups = groupHunksIntoChanges(hunks);
		expect(groups).toHaveLength(1);
		expect(groups[0].hunks).toHaveLength(1);
		expect(groups[0].hunks[0].type).toBe('removed');
	});

	it('groups adjacent removed + added at same startLine as one replacement change', () => {
		const hunks = computeDiffHunks('a\nb\nc\n', 'a\nB\nc\n');
		const groups = groupHunksIntoChanges(hunks);
		// "b" → "B" is a replacement: one removed + one added at startLine 2
		expect(groups).toHaveLength(1);
		expect(groups[0].hunks).toHaveLength(2);
		expect(groups[0].hunks[0].type).toBe('removed');
		expect(groups[0].hunks[1].type).toBe('added');
	});

	it('creates separate groups for non-adjacent changes', () => {
		const hunks = computeDiffHunks('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n');
		const groups = groupHunksIntoChanges(hunks);
		// Two separate replacements: "b"→"B" and "d"→"D"
		expect(groups).toHaveLength(2);
		expect(groups[0].index).toBe(0);
		expect(groups[1].index).toBe(1);
	});

	it('sets startLine from the first hunk in each group', () => {
		const hunks = computeDiffHunks('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n');
		const groups = groupHunksIntoChanges(hunks);
		expect(groups[0].startLine).toBe(2);
		expect(groups[1].startLine).toBe(4);
	});

	it('handles mixed pure addition and replacement', () => {
		// Change "b" to "B" (replacement) and add "f" at end (pure addition)
		const hunks = computeDiffHunks('a\nb\nc\n', 'a\nB\nc\nf\n');
		const groups = groupHunksIntoChanges(hunks);
		expect(groups).toHaveLength(2);
		// First group: replacement
		expect(groups[0].hunks).toHaveLength(2);
		// Second group: pure addition
		expect(groups[1].hunks).toHaveLength(1);
		expect(groups[1].hunks[0].type).toBe('added');
	});
});

// =============================================================================
// reconstructContent
// =============================================================================

describe('reconstructContent', () => {
	it('returns afterContent when all changes are accepted', () => {
		const before = 'a\nb\nc\n';
		const after = 'a\nB\nc\n';
		const result = reconstructContent(before, after, [true]);
		expect(result).toBe(after);
	});

	it('returns beforeContent when all changes are rejected', () => {
		const before = 'a\nb\nc\n';
		const after = 'a\nB\nc\n';
		const result = reconstructContent(before, after, [false]);
		expect(result).toBe(before);
	});

	it('handles partial accept/reject with multiple changes', () => {
		// Two replacements: "b"→"B" and "d"→"D"
		const before = 'a\nb\nc\nd\ne\n';
		const after = 'a\nB\nc\nD\ne\n';
		// Accept first change, reject second
		const result = reconstructContent(before, after, [true, false]);
		expect(result).toBe('a\nB\nc\nd\ne\n');
	});

	it('handles rejecting first change and accepting second', () => {
		const before = 'a\nb\nc\nd\ne\n';
		const after = 'a\nB\nc\nD\ne\n';
		const result = reconstructContent(before, after, [false, true]);
		expect(result).toBe('a\nb\nc\nD\ne\n');
	});

	it('handles pure addition accepted', () => {
		const before = 'a\n';
		const after = 'a\nb\n';
		const result = reconstructContent(before, after, [true]);
		expect(result).toBe(after);
	});

	it('handles pure addition rejected', () => {
		const before = 'a\n';
		const after = 'a\nb\n';
		const result = reconstructContent(before, after, [false]);
		expect(result).toBe(before);
	});

	it('handles pure removal accepted', () => {
		const before = 'a\nb\nc\n';
		const after = 'a\nc\n';
		const result = reconstructContent(before, after, [true]);
		expect(result).toBe(after);
	});

	it('handles pure removal rejected', () => {
		const before = 'a\nb\nc\n';
		const after = 'a\nc\n';
		const result = reconstructContent(before, after, [false]);
		expect(result).toBe(before);
	});

	it('preserves trailing newline behavior of afterContent', () => {
		// afterContent lacks trailing newline
		const before = 'a\nb';
		const after = 'a\nB';
		const result = reconstructContent(before, after, [true]);
		expect(result).toBe('a\nB');
		expect(result.endsWith('\n')).toBe(false);
	});

	it('handles identical content', () => {
		const content = 'same\n';
		const result = reconstructContent(content, content, []);
		expect(result).toBe(content);
	});

	it('handles new file (empty before)', () => {
		const before = '';
		const after = 'new content\n';
		const result = reconstructContent(before, after, [true]);
		expect(result).toBe(after);
	});

	it('handles deleted file (empty after)', () => {
		const before = 'old content\n';
		const after = '';
		// Accepting the deletion means the file content becomes empty
		const result = reconstructContent(before, after, [true]);
		expect(result).toBe('');
	});

	it('handles multi-line replacement with mixed decisions', () => {
		// Replace lines 2-3 and line 5
		const before = 'a\nb\nc\nd\ne\nf\n';
		const after = 'a\nB\nC\nd\nE\nf\n';
		// The diff produces: replace b,c→B,C (group 0) and replace e→E (group 1)
		const result = reconstructContent(before, after, [true, false]);
		expect(result).toBe('a\nB\nC\nd\ne\nf\n');
	});
});
