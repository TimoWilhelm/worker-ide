/**
 * Utility functions for the AI Agent Service.
 * Includes error parsing, validation helpers, and type guards.
 */

import { BINARY_EXTENSIONS } from '@shared/constants';
import { toolInputSchemas, type ToolName } from '@shared/validation';

// =============================================================================
// Type Guards
// =============================================================================

export function isBinaryFilePath(path: string): boolean {
	const extension = path.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
	return BINARY_EXTENSIONS.has(extension);
}

/**
 * Type guard for ToolName.
 */
export function isToolName(name: string): name is ToolName {
	return name in toolInputSchemas;
}

/**
 * Type guard for checking if a value is a non-null object (not array).
 */
export function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// =============================================================================
// Error Helpers
// =============================================================================

/**
 * Safely extract the `response` property from an error object if it exists.
 */
function getErrorResponse(error: unknown): Response | undefined {
	if (isRecordObject(error) && 'response' in error) {
		const candidate = error.response;
		if (candidate instanceof Response) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Parse API errors into structured format.
 * Return type uses null for `code` because the result is serialized to JSON via SSE.
 */
export function parseApiError(error: unknown): { message: string; code: string | null } {
	const raw = error instanceof Error ? error.message : String(error);
	const response = getErrorResponse(error);
	const status = response?.status;

	let upstreamType: string | undefined;
	let upstreamMessage: string | undefined;
	try {
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			if (typeof parsed.detail === 'string') {
				const innerMatch = parsed.detail.match(/\{[\s\S]*\}/);
				if (innerMatch) {
					const inner = JSON.parse(innerMatch[0].replaceAll("'", '"'));
					upstreamType = inner?.error?.type || undefined;
					upstreamMessage = inner?.error?.message || parsed.detail;
				} else {
					upstreamMessage = parsed.detail;
				}
			}
			if (parsed?.error?.type) {
				upstreamType = parsed.error.type;
				upstreamMessage = parsed.error.message || upstreamMessage;
			}
		}
	} catch {
		// No-op
	}

	if (upstreamType === 'overloaded_error' || status === 529 || /overloaded/i.test(raw) || /529/.test(raw)) {
		return {
			message: upstreamMessage || 'The AI model is currently overloaded. Please try again in a moment.',
			code: 'OVERLOADED',
		};
	}
	if (upstreamType === 'rate_limit_error' || status === 429 || /rate.?limit/i.test(raw)) {
		return {
			message: upstreamMessage || 'Rate limit exceeded. Please wait before trying again.',
			code: 'RATE_LIMIT',
		};
	}
	if (upstreamType === 'authentication_error' || status === 401 || status === 403) {
		return {
			message: upstreamMessage || 'Authentication failed. The API token may be invalid or expired.',
			code: 'AUTH_ERROR',
		};
	}
	if (upstreamType === 'invalid_request_error' || status === 400) {
		return {
			message: upstreamMessage || 'The request was invalid.',
			code: 'INVALID_REQUEST',
		};
	}
	if (status && status >= 500) {
		return {
			message: upstreamMessage || 'The AI service encountered an internal error. Please try again.',
			code: 'SERVER_ERROR',
		};
	}
	if (error instanceof Error && error.name === 'AbortError') {
		return { message: 'Request was cancelled.', code: 'ABORTED' };
	}

	// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
	return { message: upstreamMessage || raw, code: null };
}

// =============================================================================
// Conversion Helpers
// =============================================================================

/**
 * Convert a buffer to Uint8Array safely without type assertions.
 */
export function toUint8Array(buffer: Buffer | Uint8Array): Uint8Array {
	if (buffer instanceof Uint8Array) {
		return buffer;
	}
	return new Uint8Array(buffer);
}

// =============================================================================
// Diff Stats
// =============================================================================

/**
 * Compute the number of lines added and removed between two strings.
 * Returns { linesAdded, linesRemoved }.
 */
export function computeDiffStats(
	before: string | undefined | null,
	after: string | undefined | null,
): { linesAdded: number; linesRemoved: number } {
	const beforeLines = before ? before.split('\n') : [];
	const afterLines = after ? after.split('\n') : [];

	// Build a multiset of lines in each version
	const beforeCounts = new Map<string, number>();
	for (const line of beforeLines) {
		beforeCounts.set(line, (beforeCounts.get(line) ?? 0) + 1);
	}

	// Walk the "after" lines and match against the "before" multiset
	const remaining = new Map(beforeCounts);
	let matched = 0;
	for (const line of afterLines) {
		const count = remaining.get(line);
		if (count && count > 0) {
			remaining.set(line, count - 1);
			matched++;
		}
	}

	const linesRemoved = beforeLines.length - matched;
	const linesAdded = afterLines.length - matched;

	return { linesAdded, linesRemoved };
}

// =============================================================================
// Compact Diff Generation
// =============================================================================

const CONTEXT_LINES = 2;
const MAX_DIFF_LINES = 80;

/**
 * Generate a compact unified-diff-style string showing what changed between
 * two file versions. Shows removed (-) and added (+) lines with a small
 * context window. Output is capped to avoid bloating tool results.
 *
 * For new files (no before content), shows a summary instead of the full file.
 */
export function generateCompactDiff(filePath: string, before: string | undefined, after: string): string {
	if (!before) {
		const lineCount = after.split('\n').length;
		return `--- /dev/null\n+++ ${filePath}\nNew file with ${lineCount} lines`;
	}

	const beforeLines = before.split('\n');
	const afterLines = after.split('\n');

	// Find changed regions using a simple LCS-based diff
	const changes = computeLineChanges(beforeLines, afterLines);

	if (changes.length === 0) {
		return 'No changes';
	}

	// Group changes into hunks with context
	const hunks = groupChangesIntoHunks(changes, beforeLines, afterLines, CONTEXT_LINES);
	const output: string[] = [`--- ${filePath}`, `+++ ${filePath}`];
	let totalLines = 2;

	for (const hunk of hunks) {
		if (totalLines >= MAX_DIFF_LINES) {
			output.push('... (diff truncated)');
			break;
		}

		output.push(`@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`);
		totalLines++;

		for (const line of hunk.lines) {
			if (totalLines >= MAX_DIFF_LINES) {
				output.push('... (diff truncated)');
				break;
			}
			output.push(line);
			totalLines++;
		}
	}

	return output.join('\n');
}

// =============================================================================
// Internal Diff Helpers
// =============================================================================

interface LineChange {
	type: 'equal' | 'removed' | 'added';
	/** Index in the old (before) array; undefined for 'added' */
	oldIndex?: number;
	/** Index in the new (after) array; undefined for 'removed' */
	newIndex?: number;
}

interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: string[];
}

/**
 * Simple Myers-like diff: compute a list of equal/removed/added operations
 * between two line arrays. For performance, uses a greedy LCS approach that
 * is O(ND) where D is the edit distance. Falls back to a naive approach for
 * very large diffs (> 10 000 edits) to avoid runaway allocation.
 */
function computeLineChanges(oldLines: string[], newLines: string[]): LineChange[] {
	const oldLength = oldLines.length;
	const newLength = newLines.length;
	const maxD = oldLength + newLength;

	// For very large files with massive diffs, fall back to a simple
	// "remove all old, add all new" approach to avoid O(N^2) allocation.
	if (maxD > 10_000) {
		return [
			...oldLines.map((_line, index): LineChange => ({ type: 'removed', oldIndex: index })),
			...newLines.map((_line, index): LineChange => ({ type: 'added', newIndex: index })),
		];
	}

	// Myers diff (forward only, greedy)
	// v[k] stores the furthest x-position reached on diagonal k
	const v = new Map<number, number>([[1, 0]]);

	// Store the trace for backtracking
	const trace: Array<Map<number, number>> = [];

	outer: for (let d = 0; d <= maxD; d++) {
		const currentV = new Map(v);
		trace.push(currentV);

		for (let k = -d; k <= d; k += 2) {
			let x =
				k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))
					? (v.get(k + 1) ?? 0) // move down (insert)
					: (v.get(k - 1) ?? 0) + 1; // move right (delete)

			let y = x - k;

			// Follow diagonal (equal lines)
			while (x < oldLength && y < newLength && oldLines[x] === newLines[y]) {
				x++;
				y++;
			}

			v.set(k, x);

			if (x >= oldLength && y >= newLength) {
				break outer;
			}
		}
	}

	// Backtrack to build the edit script
	return backtrack(trace, oldLines, newLines);
}

/**
 * Backtrack through the Myers trace to produce a list of LineChange operations.
 */
function backtrack(trace: Array<Map<number, number>>, oldLines: string[], newLines: string[]): LineChange[] {
	const changes: LineChange[] = [];
	let x = oldLines.length;
	let y = newLines.length;

	for (let d = trace.length - 1; d >= 0; d--) {
		const currentV = trace[d];
		const k = x - y;
		const previousK = k === -d || (k !== d && (currentV.get(k - 1) ?? 0) < (currentV.get(k + 1) ?? 0)) ? k + 1 : k - 1;

		const previousX = currentV.get(previousK) ?? 0;
		const previousY = previousX - previousK;

		// Follow diagonal backwards (equal lines)
		while (x > previousX && y > previousY) {
			x--;
			y--;
			changes.push({ type: 'equal', oldIndex: x, newIndex: y });
		}

		if (d > 0) {
			if (x === previousX) {
				// Insert (added line)
				y--;
				changes.push({ type: 'added', newIndex: y });
			} else {
				// Delete (removed line)
				x--;
				changes.push({ type: 'removed', oldIndex: x });
			}
		}
	}

	changes.reverse();
	return changes;
}

/**
 * Group a flat list of line changes into hunks, each with a context window.
 */
function groupChangesIntoHunks(changes: LineChange[], oldLines: string[], newLines: string[], contextSize: number): DiffHunk[] {
	// Find indices of non-equal changes
	const changeIndices: number[] = [];
	for (const [index, change] of changes.entries()) {
		if (change.type !== 'equal') {
			changeIndices.push(index);
		}
	}

	if (changeIndices.length === 0) return [];

	// Group changes that are close together (within 2*contextSize)
	const groups: Array<{ start: number; end: number }> = [];
	let currentGroup = { start: changeIndices[0], end: changeIndices[0] };

	for (let index = 1; index < changeIndices.length; index++) {
		const changeIndex = changeIndices[index];
		// If the gap between changes is small enough, merge into same hunk
		if (changeIndex - currentGroup.end <= contextSize * 2 + 1) {
			currentGroup.end = changeIndex;
		} else {
			groups.push(currentGroup);
			currentGroup = { start: changeIndex, end: changeIndex };
		}
	}
	groups.push(currentGroup);

	// Build hunks from groups
	const hunks: DiffHunk[] = [];

	for (const group of groups) {
		const contextStart = Math.max(0, group.start - contextSize);
		const contextEnd = Math.min(changes.length - 1, group.end + contextSize);

		const hunkLines: string[] = [];
		let oldStart = Number.MAX_SAFE_INTEGER;
		let newStart = Number.MAX_SAFE_INTEGER;
		let oldCount = 0;
		let newCount = 0;

		for (let index = contextStart; index <= contextEnd; index++) {
			const change = changes[index];

			if (change.type === 'equal') {
				const lineContent = oldLines[change.oldIndex!];
				hunkLines.push(` ${lineContent}`);
				oldStart = Math.min(oldStart, change.oldIndex!);
				newStart = Math.min(newStart, change.newIndex!);
				oldCount++;
				newCount++;
			} else if (change.type === 'removed') {
				const lineContent = oldLines[change.oldIndex!];
				hunkLines.push(`-${lineContent}`);
				oldStart = Math.min(oldStart, change.oldIndex!);
				oldCount++;
			} else {
				const lineContent = newLines[change.newIndex!];
				hunkLines.push(`+${lineContent}`);
				newStart = Math.min(newStart, change.newIndex!);
				newCount++;
			}
		}

		// Fix start if no lines of a particular type were found
		if (oldStart === Number.MAX_SAFE_INTEGER) oldStart = 0;
		if (newStart === Number.MAX_SAFE_INTEGER) newStart = 0;

		hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
	}

	return hunks;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate tool input based on tool name.
 */
export function validateToolInput(
	toolName: ToolName,
	input: unknown,
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
	const schema = toolInputSchemas[toolName];
	if (!schema) {
		return { success: false, error: `Unknown tool: ${toolName}` };
	}

	const result = schema.safeParse(input);
	if (!result.success) {
		const formatted = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
		return { success: false, error: `Invalid input for ${toolName}: ${formatted}` };
	}

	return { success: true, data: result.data };
}
