/**
 * Diff Computation Utility
 *
 * Uses the `diff` package to compute line-level diffs between
 * before/after file content for inline diff display.
 */

import { diffLines } from 'diff';

// =============================================================================
// Types
// =============================================================================

export interface DiffHunk {
	/** Type of change */
	type: 'added' | 'removed';
	/** 1-indexed start line in the current (after) document */
	startLine: number;
	/** 1-indexed start line in the original (before) document */
	beforeStartLine: number;
	/** Number of lines in this hunk */
	lineCount: number;
	/** The actual text lines */
	lines: string[];
}

export interface DiffData {
	/** All diff hunks for this file */
	hunks: DiffHunk[];
	/** The original (before) content */
	beforeContent: string;
	/** The current (after) content */
	afterContent: string;
}

// =============================================================================
// Diff Computation
// =============================================================================

/**
 * Compute line-level diff hunks between before and after content.
 *
 * Returns hunks positioned relative to the "after" document (which is
 * what the editor currently shows). Added lines map directly to editor
 * lines. Removed lines are attached to the editor line where they were
 * removed from (for widget decoration).
 *
 * Trailing newlines are normalised before diffing so that a change from
 * `"foo"` to `"foo\n"` (or vice-versa) does not produce a phantom hunk
 * where the last line appears both removed and added with identical text.
 */
export function computeDiffHunks(beforeContent: string, afterContent: string): DiffHunk[] {
	if (beforeContent === afterContent) return [];

	// Normalise trailing newlines so the diff engine doesn't report the
	// last line as changed when only the trailing newline differs.
	const normalisedBefore = ensureTrailingNewline(beforeContent);
	const normalisedAfter = ensureTrailingNewline(afterContent);

	if (normalisedBefore === normalisedAfter) return [];

	const changes = diffLines(normalisedBefore, normalisedAfter);
	const hunks: DiffHunk[] = [];

	// Track the current line in both documents (1-indexed)
	let afterLine = 1;
	let beforeLine = 1;

	for (const change of changes) {
		const lines = splitLines(change.value);
		const lineCount = lines.length;

		if (change.added) {
			hunks.push({
				type: 'added',
				startLine: afterLine,
				beforeStartLine: beforeLine,
				lineCount,
				lines,
			});
			afterLine += lineCount;
		} else if (change.removed) {
			// Removed lines are shown as a widget at the current after-line position
			hunks.push({
				type: 'removed',
				startLine: afterLine,
				beforeStartLine: beforeLine,
				lineCount,
				lines,
			});
			// Don't advance afterLine — removed lines don't exist in the after doc
			beforeLine += lineCount;
		} else {
			// Unchanged — just advance both line counters
			afterLine += lineCount;
			beforeLine += lineCount;
		}
	}

	return hunks;
}

/**
 * Compute full DiffData for a file change.
 * Returns undefined if there's nothing to diff.
 */
export function computeDiffData(beforeContent = '', afterContent = ''): DiffData | undefined {
	if (beforeContent === afterContent) return undefined;

	const hunks = computeDiffHunks(beforeContent, afterContent);
	if (hunks.length === 0) return undefined;

	return { hunks, beforeContent, afterContent };
}

// =============================================================================
// Change Groups — logical grouping of adjacent hunks for per-change accept/reject
// =============================================================================

/**
 * A logical change in the diff: either a pure addition, a pure removal,
 * or a replacement (adjacent removed + added hunks at the same position).
 * Each change group gets one accept/reject action bar.
 */
export interface ChangeGroup {
	/** Index of this group (0-based), used for hunkStatuses[] */
	index: number;
	/** The hunks that make up this change group (1 or 2 hunks) */
	hunks: DiffHunk[];
	/** 1-indexed start line in the after document (from the first hunk) */
	startLine: number;
}

/**
 * Group adjacent removed + added hunks into logical change groups.
 *
 * A removed hunk immediately followed by an added hunk at the same
 * `startLine` is treated as a single "replacement" change.  All other
 * hunks become their own group.
 *
 * The returned groups are in document order.
 */
export function groupHunksIntoChanges(hunks: DiffHunk[]): ChangeGroup[] {
	const groups: ChangeGroup[] = [];
	let index = 0;

	for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
		const hunk = hunks[hunkIndex];
		const nextHunk = hunks[hunkIndex + 1];

		// A removed hunk followed by an added hunk at the same startLine
		// forms a single "replacement" change group.
		if (hunk.type === 'removed' && nextHunk?.type === 'added' && nextHunk.startLine === hunk.startLine) {
			groups.push({
				index,
				hunks: [hunk, nextHunk],
				startLine: hunk.startLine,
			});
			hunkIndex++; // skip the added hunk (already consumed)
		} else {
			groups.push({
				index,
				hunks: [hunk],
				startLine: hunk.startLine,
			});
		}

		index++;
	}

	return groups;
}

/**
 * Reconstruct file content after partial hunk accept/reject.
 *
 * Walks the raw `diffLines()` output and for each change decides whether
 * to keep the "before" (rejected) or "after" (accepted) version based
 * on the `decisions` array.
 *
 * @param beforeContent - Original file content
 * @param afterContent  - AI-modified file content
 * @param decisions     - Per-change-group decisions: `true` = accepted (keep added, drop removed),
 *                        `false` = rejected (keep removed, drop added).
 *                        Must match the length of `groupHunksIntoChanges()` output.
 * @returns The reconstructed file content
 */
export function reconstructContent(beforeContent: string, afterContent: string, decisions: boolean[]): string {
	const normalisedBefore = ensureTrailingNewline(beforeContent);
	const normalisedAfter = ensureTrailingNewline(afterContent);

	if (normalisedBefore === normalisedAfter) return afterContent;

	const changes = diffLines(normalisedBefore, normalisedAfter);
	const result: string[] = [];

	// Build change groups from hunks to map diff changes to decisions
	let groupIndex = 0;
	let changeIndex = 0;

	while (changeIndex < changes.length) {
		const change = changes[changeIndex];

		if (!change.added && !change.removed) {
			// Unchanged — always include
			result.push(change.value);
			changeIndex++;
		} else if (change.removed) {
			const nextChange = changes[changeIndex + 1];
			const isReplacement = nextChange?.added;
			const accepted = decisions[groupIndex] ?? true;

			if (isReplacement) {
				// Replacement: removed + added pair
				if (accepted) {
					// Accept: use the added (new) content
					result.push(nextChange.value);
				} else {
					// Reject: use the removed (original) content
					result.push(change.value);
				}
				changeIndex += 2; // skip both removed and added
			} else {
				// Pure removal (no added follows)
				if (accepted) {
					// Accept removal: drop the content (don't include it)
				} else {
					// Reject removal: keep the original content
					result.push(change.value);
				}
				changeIndex++;
			}
			groupIndex++;
		} else if (change.added) {
			// Pure addition (no removed precedes — that case is handled above)
			const accepted = decisions[groupIndex] ?? true;
			if (accepted) {
				// Accept addition: include the new content
				result.push(change.value);
			}
			// Reject addition: don't include it
			changeIndex++;
			groupIndex++;
		}
	}

	const reconstructed = result.join('');

	// Preserve the original trailing newline behaviour of the afterContent:
	// if the after didn't end with a newline but our reconstruction does
	// (from the normalisation), strip it.
	if (!afterContent.endsWith('\n') && reconstructed.endsWith('\n')) {
		return reconstructed.slice(0, -1);
	}

	return reconstructed;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Ensure a non-empty string ends with exactly one newline.
 * Empty strings are returned as-is so that an empty → non-empty diff
 * doesn't produce a spurious removed-newline hunk.
 */
function ensureTrailingNewline(content: string): string {
	if (!content) return content;
	return content.endsWith('\n') ? content : content + '\n';
}

/**
 * Split text into lines, handling trailing newlines correctly.
 * A trailing newline does NOT produce an extra empty line.
 */
function splitLines(text: string): string[] {
	if (!text) return [];
	const lines = text.split('\n');
	// diff package includes trailing newline in the value — remove the empty last element
	if (lines.length > 0 && lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}
