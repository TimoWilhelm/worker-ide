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

export interface DiffHunkSessionStep {
	afterContent: string;
	sessionId: string;
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

interface LineToken {
	originLineNumbers: number[];
	sessionIds: string[];
}

export function computeDiffHunkSessionIds(
	beforeContent: string,
	afterContent: string,
	steps: DiffHunkSessionStep[],
	fallbackSessionId: string,
): string[][] {
	const groups = groupHunksIntoChanges(computeDiffHunks(beforeContent, afterContent));
	if (groups.length === 0) {
		return [];
	}

	const fallback = groups.map(() => [fallbackSessionId]);
	if (steps.length === 0) {
		return fallback;
	}

	let currentContent = beforeContent;
	let currentTokens: LineToken[] = splitLines(beforeContent).map((_, index) => ({
		originLineNumbers: [index + 1],
		sessionIds: [],
	}));
	const deletedSessionsByOriginLine = new Map<number, string[]>();

	for (const step of steps) {
		if (!step.sessionId || step.afterContent === currentContent) {
			currentContent = step.afterContent;
			continue;
		}

		const nextTokens: LineToken[] = [];
		const changes = diffLines(ensureTrailingNewline(currentContent), ensureTrailingNewline(step.afterContent));
		let tokenIndex = 0;

		for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
			const change = changes[changeIndex];
			const lineCount = splitLines(change.value).length;

			if (!change.added && !change.removed) {
				nextTokens.push(...currentTokens.slice(tokenIndex, tokenIndex + lineCount));
				tokenIndex += lineCount;
				continue;
			}

			if (change.removed) {
				const removedTokens = currentTokens.slice(tokenIndex, tokenIndex + lineCount);
				tokenIndex += lineCount;

				const nextChange = changes[changeIndex + 1];
				if (nextChange?.added) {
					const addedLines = splitLines(nextChange.value);
					const originLineNumbers = uniqueStrings(removedTokens.flatMap((token) => token.originLineNumbers.map(String))).map(Number);
					const sessionIds = uniqueStrings([...removedTokens.flatMap((token) => token.sessionIds), step.sessionId]);
					for (const _ of addedLines) {
						nextTokens.push({ originLineNumbers, sessionIds });
					}
					changeIndex++;
					continue;
				}

				const deletionSessionIds = uniqueStrings([...removedTokens.flatMap((token) => token.sessionIds), step.sessionId]);
				for (const token of removedTokens) {
					for (const originLineNumber of token.originLineNumbers) {
						deletedSessionsByOriginLine.set(
							originLineNumber,
							uniqueStrings([...(deletedSessionsByOriginLine.get(originLineNumber) ?? []), ...deletionSessionIds]),
						);
					}
				}
				continue;
			}

			for (const _ of splitLines(change.value)) {
				nextTokens.push({ originLineNumbers: [], sessionIds: [step.sessionId] });
			}
		}

		currentTokens = nextTokens;
		currentContent = step.afterContent;
	}

	if (currentContent !== afterContent) {
		return fallback;
	}

	return groups.map((group) => {
		const sessionIds = new Set<string>();
		let hasAddedHunk = false;

		for (const hunk of group.hunks) {
			if (hunk.type === 'added') {
				hasAddedHunk = true;
				for (let index = 0; index < hunk.lineCount; index++) {
					for (const sessionId of currentTokens[hunk.startLine + index - 1]?.sessionIds ?? []) {
						sessionIds.add(sessionId);
					}
				}
			}
		}

		if (!hasAddedHunk) {
			for (const hunk of group.hunks) {
				for (let index = 0; index < hunk.lineCount; index++) {
					for (const sessionId of deletedSessionsByOriginLine.get(hunk.beforeStartLine + index) ?? []) {
						sessionIds.add(sessionId);
					}
				}
			}
		}

		return sessionIds.size > 0 ? [...sessionIds] : [fallbackSessionId];
	});
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

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function splitLines(text: string): string[] {
	if (!text) return [];
	const lines = text.split('\n');
	if (lines.length > 0 && lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}
