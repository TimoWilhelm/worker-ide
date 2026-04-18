import { diffLines } from 'diff';

export interface DiffHunk {
	type: 'added' | 'removed';
	startLine: number;
	beforeStartLine: number;
	lineCount: number;
	lines: string[];
}

export interface DiffData {
	hunks: DiffHunk[];
	beforeContent: string;
	afterContent: string;
}

export interface ChangeGroup {
	index: number;
	hunks: DiffHunk[];
	startLine: number;
}

export function computeDiffHunks(beforeContent: string, afterContent: string): DiffHunk[] {
	if (beforeContent === afterContent) return [];

	const normalisedBefore = ensureTrailingNewline(beforeContent);
	const normalisedAfter = ensureTrailingNewline(afterContent);

	if (normalisedBefore === normalisedAfter) return [];

	const changes = diffLines(normalisedBefore, normalisedAfter);
	const hunks: DiffHunk[] = [];

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
			hunks.push({
				type: 'removed',
				startLine: afterLine,
				beforeStartLine: beforeLine,
				lineCount,
				lines,
			});
			beforeLine += lineCount;
		} else {
			afterLine += lineCount;
			beforeLine += lineCount;
		}
	}

	return hunks;
}

export function computeDiffData(beforeContent = '', afterContent = ''): DiffData | undefined {
	if (beforeContent === afterContent) return undefined;

	const hunks = computeDiffHunks(beforeContent, afterContent);
	if (hunks.length === 0) return undefined;

	return { hunks, beforeContent, afterContent };
}

export function groupHunksIntoChanges(hunks: DiffHunk[]): ChangeGroup[] {
	const groups: ChangeGroup[] = [];
	let index = 0;

	for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
		const hunk = hunks[hunkIndex];
		const nextHunk = hunks[hunkIndex + 1];

		if (hunk.type === 'removed' && nextHunk?.type === 'added' && nextHunk.startLine === hunk.startLine) {
			groups.push({
				index,
				hunks: [hunk, nextHunk],
				startLine: hunk.startLine,
			});
			hunkIndex++;
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

export function reconstructContent(beforeContent: string, afterContent: string, decisions: boolean[]): string {
	const normalisedBefore = ensureTrailingNewline(beforeContent);
	const normalisedAfter = ensureTrailingNewline(afterContent);

	if (normalisedBefore === normalisedAfter) return afterContent;

	const changes = diffLines(normalisedBefore, normalisedAfter);
	const result: string[] = [];

	let groupIndex = 0;
	let changeIndex = 0;

	while (changeIndex < changes.length) {
		const change = changes[changeIndex];

		if (!change.added && !change.removed) {
			result.push(change.value);
			changeIndex++;
		} else if (change.removed) {
			const nextChange = changes[changeIndex + 1];
			const isReplacement = nextChange?.added;
			const accepted = decisions[groupIndex] ?? true;

			if (isReplacement) {
				if (accepted) {
					result.push(nextChange.value);
				} else {
					result.push(change.value);
				}
				changeIndex += 2;
			} else {
				if (!accepted) {
					result.push(change.value);
				}
				changeIndex++;
			}
			groupIndex++;
		} else if (change.added) {
			const accepted = decisions[groupIndex] ?? true;
			if (accepted) {
				result.push(change.value);
			}
			changeIndex++;
			groupIndex++;
		}
	}

	const reconstructed = result.join('');
	if (!afterContent.endsWith('\n') && reconstructed.endsWith('\n')) {
		return reconstructed.slice(0, -1);
	}

	return reconstructed;
}

function ensureTrailingNewline(content: string): string {
	if (!content) return content;
	return content.endsWith('\n') ? content : `${content}\n`;
}

function splitLines(text: string): string[] {
	if (!text) return [];
	const lines = text.split('\n');
	if (lines.length > 0 && lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}
