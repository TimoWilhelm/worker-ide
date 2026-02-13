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
	/** 1-indexed start line in the current (after) document for 'added' hunks */
	startLine: number;
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
 */
export function computeDiffHunks(beforeContent: string, afterContent: string): DiffHunk[] {
	if (beforeContent === afterContent) return [];

	const changes = diffLines(beforeContent, afterContent);
	const hunks: DiffHunk[] = [];

	// Track the current line in the "after" document (1-indexed)
	let afterLine = 1;

	for (const change of changes) {
		const lines = splitLines(change.value);
		const lineCount = lines.length;

		if (change.added) {
			hunks.push({
				type: 'added',
				startLine: afterLine,
				lineCount,
				lines,
			});
			afterLine += lineCount;
		} else if (change.removed) {
			// Removed lines are shown as a widget at the current after-line position
			hunks.push({
				type: 'removed',
				startLine: afterLine,
				lineCount,
				lines,
			});
			// Don't advance afterLine — removed lines don't exist in the after doc
		} else {
			// Unchanged — just advance the line counter
			afterLine += lineCount;
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
// Helpers
// =============================================================================

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
