/**
 * File Mention Hook
 *
 * Manages the state for @-mentioning files in the AI chat input.
 * Detects when the user types "@" followed by a search query,
 * filters files with fuzzy matching, and handles keyboard navigation.
 */

import { useCallback, useMemo, useState } from 'react';

import type { InputSegment } from '../lib/input-segments';
import type { FileInfo } from '@shared/types';

const MAX_RESULTS = 8;

/**
 * Characters allowed in a file-mention query.
 * Allows: letters, digits, slash, dot, dash, underscore.
 * Rejects: whitespace, ?, !, #, *, etc.
 */
const VALID_QUERY_CHARACTERS = /^[\w./-]+$/;

// =============================================================================
// Fuzzy matching
// =============================================================================

/**
 * Simple fuzzy match: checks if all characters in the query appear
 * in order within the candidate string. Returns a score (lower = better)
 * or -1 if no match.
 */
function fuzzyMatch(query: string, candidate: string): number {
	const lowerQuery = query.toLowerCase();
	const lowerCandidate = candidate.toLowerCase();

	// Prefer exact substring match
	const substringIndex = lowerCandidate.indexOf(lowerQuery);
	if (substringIndex !== -1) {
		// Bonus for matching at the start or after a separator
		if (substringIndex === 0) return 0;
		const charBefore = lowerCandidate[substringIndex - 1];
		if (charBefore === '/' || charBefore === '.') return 1;
		return 2;
	}

	// Fall back to subsequence matching
	let queryIndex = 0;
	let gaps = 0;
	for (let index = 0; index < lowerCandidate.length && queryIndex < lowerQuery.length; index++) {
		if (lowerCandidate[index] === lowerQuery[queryIndex]) {
			queryIndex++;
		} else if (queryIndex > 0) {
			gaps++;
		}
	}

	if (queryIndex === lowerQuery.length) {
		return 10 + gaps;
	}

	return -1;
}

// =============================================================================
// Helper: compute pill offsets
// =============================================================================

/**
 * Compute the set of plain-text offsets that correspond to the "@" of a
 * mention pill. These offsets should NOT trigger the dropdown.
 */
function getMentionAtOffsets(segments: InputSegment[]): Set<number> {
	const offsets = new Set<number>();
	let position = 0;
	for (const segment of segments) {
		if (segment.type === 'mention') {
			offsets.add(position); // the "@" at this offset is from a pill
			position += 1 + segment.path.length; // @+path
		} else {
			position += segment.value.length;
		}
	}
	return offsets;
}

// =============================================================================
// Helper: detect @ trigger
// =============================================================================

interface TriggerInfo {
	isTriggered: boolean;
	query: string;
	triggerIndex: number;
}

/**
 * Detect whether there's an active @ trigger at the cursor position.
 * Skips "@" characters that belong to mention pills.
 * Rejects queries containing whitespace or invalid filename characters.
 */
function detectTrigger(inputValue: string, cursorPosition: number, pillOffsets: Set<number>): TriggerInfo {
	const notTriggered: TriggerInfo = { isTriggered: false, query: '', triggerIndex: -1 };
	const textBeforeCursor = inputValue.slice(0, cursorPosition);

	// Search backwards for an "@" that isn't from a pill
	let lastAtIndex = -1;
	for (let index = textBeforeCursor.length - 1; index >= 0; index--) {
		if (textBeforeCursor[index] === '@' && !pillOffsets.has(index)) {
			lastAtIndex = index;
			break;
		}
	}

	if (lastAtIndex === -1) {
		return notTriggered;
	}

	// The @ must be at the start of input or preceded by a space/newline/tab
	if (lastAtIndex > 0) {
		const charBefore = textBeforeCursor[lastAtIndex - 1];
		if (charBefore !== ' ' && charBefore !== '\n' && charBefore !== '\t') {
			return notTriggered;
		}
	}

	// Text between @ and cursor is the query
	const query = textBeforeCursor.slice(lastAtIndex + 1);

	// Empty query is valid (show all files)
	if (query.length === 0) {
		return { isTriggered: true, query: '', triggerIndex: lastAtIndex };
	}

	// Reject if query contains any invalid character (whitespace, special chars)
	if (!VALID_QUERY_CHARACTERS.test(query)) {
		return notTriggered;
	}

	return { isTriggered: true, query, triggerIndex: lastAtIndex };
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook that manages the file mention autocomplete state.
 *
 * @param files - Full list of project files from the store
 * @param segments - Current input segments (to distinguish pill @ from typed @)
 * @param inputValue - Current plain-text representation of the input
 * @param cursorPosition - Current cursor position in the plain text
 * @param onSelect - Callback when a file is selected
 */
export function useFileMention({
	files,
	segments,
	inputValue,
	cursorPosition,
	onSelect,
}: {
	files: FileInfo[];
	segments: InputSegment[];
	inputValue: string;
	cursorPosition: number;
	onSelect: (path: string, triggerIndex: number, queryLength: number) => void;
}) {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [dismissed, setDismissed] = useState(false);
	const [previousQuery, setPreviousQuery] = useState('');

	// Compute which "@" offsets belong to pills
	const pillOffsets = useMemo(() => getMentionAtOffsets(segments), [segments]);

	// Detect @ trigger during render
	const trigger = detectTrigger(inputValue, cursorPosition, pillOffsets);

	// Re-open when the trigger text changes (user started typing after @)
	const isOpen = trigger.isTriggered && !dismissed;

	// Reset dismissed state when the trigger disappears
	if (!trigger.isTriggered && dismissed) {
		setDismissed(false);
	}

	// Reset selection when query changes (set-state-during-render pattern)
	if (trigger.query !== previousQuery) {
		setPreviousQuery(trigger.query);
		if (selectedIndex !== 0) {
			setSelectedIndex(0);
		}
	}

	// Filter and score files based on query
	const results = useMemo(() => {
		if (!isOpen) return [];

		const query = trigger.query;

		// If no query, show first N files sorted by path length (shortest first)
		if (!query) {
			return files.toSorted((a, b) => a.path.length - b.path.length).slice(0, MAX_RESULTS);
		}

		// Score each file against the query (match against full path and file name)
		const scored: Array<{ file: FileInfo; score: number }> = [];
		for (const file of files) {
			const pathScore = fuzzyMatch(query, file.path);
			const nameScore = fuzzyMatch(query, file.name);
			// Use the best (lowest) score from either match
			const bestScore = pathScore === -1 ? nameScore : nameScore === -1 ? pathScore : Math.min(pathScore, nameScore);
			if (bestScore !== -1) {
				scored.push({ file, score: bestScore });
			}
		}

		// Sort by score (lower is better), then by path length
		return scored
			.toSorted((a, b) => a.score - b.score || a.file.path.length - b.file.path.length)
			.slice(0, MAX_RESULTS)
			.map((entry) => entry.file);
	}, [isOpen, trigger.query, files]);

	// Clamp selectedIndex if results changed
	const clampedSelectedIndex = Math.min(selectedIndex, Math.max(0, results.length - 1));

	// Keyboard handler (to be called from textarea onKeyDown)
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (!isOpen || results.length === 0) return false;

			switch (event.key) {
				case 'ArrowDown': {
					event.preventDefault();
					setSelectedIndex((previous) => (previous + 1) % results.length);
					return true;
				}
				case 'ArrowUp': {
					event.preventDefault();
					setSelectedIndex((previous) => (previous - 1 + results.length) % results.length);
					return true;
				}
				case 'Enter':
				case 'Tab': {
					event.preventDefault();
					const selected = results[clampedSelectedIndex];
					if (selected) {
						onSelect(selected.path, trigger.triggerIndex, trigger.query.length);
						setDismissed(true);
					}
					return true;
				}
				case 'Escape': {
					event.preventDefault();
					setDismissed(true);
					return true;
				}
				default: {
					return false;
				}
			}
		},
		[isOpen, results, clampedSelectedIndex, trigger.triggerIndex, trigger.query.length, onSelect],
	);

	const selectFile = useCallback(
		(index: number) => {
			const selected = results[index];
			if (selected) {
				onSelect(selected.path, trigger.triggerIndex, trigger.query.length);
				setDismissed(true);
			}
		},
		[results, trigger.triggerIndex, trigger.query.length, onSelect],
	);

	const close = useCallback(() => {
		setDismissed(true);
	}, []);

	return {
		isOpen,
		query: trigger.query,
		results,
		selectedIndex: clampedSelectedIndex,
		triggerIndex: trigger.triggerIndex,
		handleKeyDown,
		selectFile,
		close,
	};
}
