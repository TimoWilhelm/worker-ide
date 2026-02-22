/**
 * String replacement strategies for file_edit tool.
 *
 * These replacers are adapted from:
 * - https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
 * - https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
 * - https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts
 */

// =============================================================================
// Types
// =============================================================================

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

// =============================================================================
// Constants
// =============================================================================

// Similarity thresholds for block anchor fallback matching.
// A threshold of 0 for single candidates means any block whose first and last
// lines match is accepted regardless of middle content. This is intentionally
// aggressive to maximize patch success rate.
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3;

// =============================================================================
// Levenshtein Distance
// =============================================================================

/**
 * Levenshtein distance algorithm implementation
 */
export function levenshtein(a: string, b: string): number {
	// Handle empty strings
	if (a === '' || b === '') {
		return Math.max(a.length, b.length);
	}

	const matrix = Array.from({ length: a.length + 1 }, (_, index) =>
		Array.from({ length: b.length + 1 }, (_, index_) => (index === 0 ? index_ : index_ === 0 ? index : 0)),
	);

	for (let index = 1; index <= a.length; index++) {
		for (let index_ = 1; index_ <= b.length; index_++) {
			const cost = a[index - 1] === b[index_ - 1] ? 0 : 1;
			matrix[index][index_] = Math.min(matrix[index - 1][index_] + 1, matrix[index][index_ - 1] + 1, matrix[index - 1][index_ - 1] + cost);
		}
	}

	return matrix[a.length][b.length];
}

// =============================================================================
// Replacer Strategies
// =============================================================================

/**
 * 1. SimpleReplacer - Exact string match
 */
export const SimpleReplacer: Replacer = function* (_content, find) {
	yield find;
};

/**
 * 2. LineTrimmedReplacer - Match with trimmed whitespace per line
 */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
	const originalLines = content.split('\n');
	const searchLines = find.split('\n');

	if (searchLines.length > 0 && searchLines.at(-1) === '') {
		searchLines.pop();
	}

	for (let index = 0; index <= originalLines.length - searchLines.length; index++) {
		let matches = true;

		for (const [index_, searchLine] of searchLines.entries()) {
			const originalTrimmed = originalLines[index + index_].trim();
			const searchTrimmed = searchLine.trim();

			if (originalTrimmed !== searchTrimmed) {
				matches = false;
				break;
			}
		}

		if (matches) {
			let matchStartIndex = 0;
			for (let k = 0; k < index; k++) {
				matchStartIndex += originalLines[k].length + 1;
			}

			let matchEndIndex = matchStartIndex;
			for (let k = 0; k < searchLines.length; k++) {
				matchEndIndex += originalLines[index + k].length;
				if (k < searchLines.length - 1) {
					matchEndIndex += 1; // Add newline character except for the last line
				}
			}

			yield content.slice(matchStartIndex, matchEndIndex);
		}
	}
};

/**
 * 3. BlockAnchorReplacer - Match based on first/last line anchors with similarity scoring
 */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
	const originalLines = content.split('\n');
	const searchLines = find.split('\n');

	if (searchLines.length < 3) {
		return;
	}

	if (searchLines.length > 0 && searchLines.at(-1) === '') {
		searchLines.pop();
	}

	const firstLineSearch = searchLines[0].trim();
	const lastLineSearch = searchLines.at(-1)!.trim();
	const searchBlockSize = searchLines.length;

	// Collect all candidate positions where both anchors match
	const candidates: Array<{ startLine: number; endLine: number }> = [];
	for (let index = 0; index < originalLines.length; index++) {
		if (originalLines[index].trim() !== firstLineSearch) {
			continue;
		}

		// Look for the matching last line after this first line
		for (let index_ = index + 2; index_ < originalLines.length; index_++) {
			if (originalLines[index_].trim() === lastLineSearch) {
				candidates.push({ startLine: index, endLine: index_ });
				break; // Only match the first occurrence of the last line
			}
		}
	}

	// Return immediately if no candidates
	if (candidates.length === 0) {
		return;
	}

	// Handle single candidate scenario (using relaxed threshold)
	if (candidates.length === 1) {
		const { startLine, endLine } = candidates[0];
		const actualBlockSize = endLine - startLine + 1;

		let similarity = 0;
		const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2); // Middle lines only

		if (linesToCheck > 0) {
			for (let index_ = 1; index_ < searchBlockSize - 1 && index_ < actualBlockSize - 1; index_++) {
				const originalLine = originalLines[startLine + index_].trim();
				const searchLine = searchLines[index_].trim();
				const maxLength = Math.max(originalLine.length, searchLine.length);
				if (maxLength === 0) {
					continue;
				}
				const distance = levenshtein(originalLine, searchLine);
				similarity += (1 - distance / maxLength) / linesToCheck;

				// Exit early when threshold is reached
				if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
					break;
				}
			}
		} else {
			// No middle lines to compare, just accept based on anchors
			similarity = 1;
		}

		if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
			let matchStartIndex = 0;
			for (let k = 0; k < startLine; k++) {
				matchStartIndex += originalLines[k].length + 1;
			}
			let matchEndIndex = matchStartIndex;
			for (let k = startLine; k <= endLine; k++) {
				matchEndIndex += originalLines[k].length;
				if (k < endLine) {
					matchEndIndex += 1; // Add newline character except for the last line
				}
			}
			yield content.slice(matchStartIndex, matchEndIndex);
		}
		return;
	}

	// Calculate similarity for multiple candidates
	let bestMatch: { startLine: number; endLine: number } | undefined;
	let maxSimilarity = -1;

	for (const candidate of candidates) {
		const { startLine, endLine } = candidate;
		const actualBlockSize = endLine - startLine + 1;

		let similarity = 0;
		const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2); // Middle lines only

		if (linesToCheck > 0) {
			for (let index_ = 1; index_ < searchBlockSize - 1 && index_ < actualBlockSize - 1; index_++) {
				const originalLine = originalLines[startLine + index_].trim();
				const searchLine = searchLines[index_].trim();
				const maxLength = Math.max(originalLine.length, searchLine.length);
				if (maxLength === 0) {
					continue;
				}
				const distance = levenshtein(originalLine, searchLine);
				similarity += 1 - distance / maxLength;
			}
			similarity /= linesToCheck; // Average similarity
		} else {
			// No middle lines to compare, just accept based on anchors
			similarity = 1;
		}

		if (similarity > maxSimilarity) {
			maxSimilarity = similarity;
			bestMatch = candidate;
		}
	}

	// Threshold judgment
	if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
		const { startLine, endLine } = bestMatch;
		let matchStartIndex = 0;
		for (let k = 0; k < startLine; k++) {
			matchStartIndex += originalLines[k].length + 1;
		}
		let matchEndIndex = matchStartIndex;
		for (let k = startLine; k <= endLine; k++) {
			matchEndIndex += originalLines[k].length;
			if (k < endLine) {
				matchEndIndex += 1;
			}
		}
		yield content.slice(matchStartIndex, matchEndIndex);
	}
};

/**
 * Helper: normalize whitespace by collapsing runs of whitespace to single space
 */
function normalizeWhitespace(text: string): string {
	return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * 4. WhitespaceNormalizedReplacer - Collapse whitespace for matching
 */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
	const normalizedFind = normalizeWhitespace(find);

	// Handle single line matches
	const lines = content.split('\n');
	for (const line of lines) {
		if (normalizeWhitespace(line) === normalizedFind) {
			yield line;
		} else {
			// Only check for substring matches if the full line doesn't match
			const normalizedLine = normalizeWhitespace(line);
			if (normalizedLine.includes(normalizedFind)) {
				// Find the actual substring in the original line that matches
				const words = find.trim().split(/\s+/);
				if (words.length > 0) {
					const pattern = words.map((word) => word.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join(String.raw`\s+`);
					try {
						const regex = new RegExp(pattern);
						const match = line.match(regex);
						if (match) {
							yield match[0];
						}
					} catch {
						// Invalid regex pattern, skip
					}
				}
			}
		}
	}

	// Handle multi-line matches
	const findLines = find.split('\n');
	if (findLines.length > 1) {
		for (let index = 0; index <= lines.length - findLines.length; index++) {
			const block = lines.slice(index, index + findLines.length);
			if (normalizeWhitespace(block.join('\n')) === normalizedFind) {
				yield block.join('\n');
			}
		}
	}
};

/**
 * Helper: remove common leading indentation from a text block
 */
function removeIndentation(text: string): string {
	const lines = text.split('\n');
	const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
	if (nonEmptyLines.length === 0) return text;

	const minIndent = Math.min(
		...nonEmptyLines.map((line) => {
			const match = /^(\s*)/.exec(line);
			return match ? match[1].length : 0;
		}),
	);

	return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n');
}

/**
 * 5. IndentationFlexibleReplacer - Ignore leading indentation
 */
export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
	const normalizedFind = removeIndentation(find);
	const contentLines = content.split('\n');
	const findLines = find.split('\n');

	for (let index = 0; index <= contentLines.length - findLines.length; index++) {
		const block = contentLines.slice(index, index + findLines.length).join('\n');
		if (removeIndentation(block) === normalizedFind) {
			yield block;
		}
	}
};

/**
 * Helper: unescape common escape sequences
 */
function unescapeString(string_: string): string {
	return string_.replaceAll(/\\([ntr'"`\\$]|\n)/g, (match, capturedChar: string) => {
		switch (capturedChar) {
			case 'n': {
				return '\n';
			}
			case 't': {
				return '\t';
			}
			case 'r': {
				return '\r';
			}
			case "'": {
				return "'";
			}
			case '"': {
				return '"';
			}
			case '`': {
				return '`';
			}
			case '\\': {
				return '\\';
			}
			case '\n': {
				return '\n';
			}
			case '$': {
				return '$';
			}
			default: {
				return match;
			}
		}
	});
}

/**
 * 6. EscapeNormalizedReplacer - Handle escape sequences
 */
export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
	const unescapedFind = unescapeString(find);

	// Try direct match with unescaped find string
	if (content.includes(unescapedFind)) {
		yield unescapedFind;
	}

	// Also try finding escaped versions in content that match unescaped find
	const lines = content.split('\n');
	const findLines = unescapedFind.split('\n');

	for (let index = 0; index <= lines.length - findLines.length; index++) {
		const block = lines.slice(index, index + findLines.length).join('\n');
		const unescapedBlock = unescapeString(block);

		if (unescapedBlock === unescapedFind) {
			yield block;
		}
	}
};

/**
 * 7. TrimmedBoundaryReplacer - Try trimmed version of find string
 */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
	const trimmedFind = find.trim();

	if (trimmedFind === find) {
		// Already trimmed, no point in trying
		return;
	}

	// Try to find the trimmed version
	if (content.includes(trimmedFind)) {
		yield trimmedFind;
	}

	// Also try finding blocks where trimmed content matches
	const lines = content.split('\n');
	const findLines = find.split('\n');

	for (let index = 0; index <= lines.length - findLines.length; index++) {
		const block = lines.slice(index, index + findLines.length).join('\n');

		if (block.trim() === trimmedFind) {
			yield block;
		}
	}
};

/**
 * 8. ContextAwareReplacer - Context-based matching using first/last lines as anchors
 */
export const ContextAwareReplacer: Replacer = function* (content, find) {
	const findLines = find.split('\n');
	if (findLines.length < 3) {
		// Need at least 3 lines to have meaningful context
		return;
	}

	// Remove trailing empty line if present
	if (findLines.length > 0 && findLines.at(-1) === '') {
		findLines.pop();
	}

	const contentLines = content.split('\n');

	// Extract first and last lines as context anchors
	const firstLine = findLines[0].trim();
	const lastLine = findLines.at(-1)!.trim();

	// Find blocks that start and end with the context anchors
	for (let index = 0; index < contentLines.length; index++) {
		if (contentLines[index].trim() !== firstLine) continue;

		// Look for the matching last line
		for (let index_ = index + 2; index_ < contentLines.length; index_++) {
			if (contentLines[index_].trim() === lastLine) {
				// Found a potential context block
				const blockLines = contentLines.slice(index, index_ + 1);
				const block = blockLines.join('\n');

				// Check if the middle content has reasonable similarity
				// (simple heuristic: at least 50% of non-empty lines should match when trimmed)
				if (blockLines.length === findLines.length) {
					let matchingLines = 0;
					let totalNonEmptyLines = 0;

					for (let k = 1; k < blockLines.length - 1; k++) {
						const blockLine = blockLines[k].trim();
						const findLine = findLines[k].trim();

						if (blockLine.length > 0 || findLine.length > 0) {
							totalNonEmptyLines++;
							if (blockLine === findLine) {
								matchingLines++;
							}
						}
					}

					if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
						yield block;
						break; // Only match the first occurrence
					}
				}
				break;
			}
		}
	}
};

/**
 * 9. MultiOccurrenceReplacer - Yields all exact matches for replaceAll
 */
export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
	// This replacer yields all exact matches, allowing the replace function
	// to handle multiple occurrences based on replaceAll parameter
	let startIndex = 0;

	while (true) {
		const index = content.indexOf(find, startIndex);
		if (index === -1) break;

		yield find;
		startIndex = index + find.length;
	}
};

// =============================================================================
// Main Replace Function
// =============================================================================

/**
 * Replace oldString with newString in content using multiple replacement strategies.
 * Tries each strategy in order until one succeeds.
 *
 * @param content - The original file content
 * @param oldString - The string to find and replace
 * @param newString - The replacement string
 * @param replaceAll - If true, replace all occurrences; if false, require unique match
 * @returns The new content with replacements applied
 * @throws Error if oldString cannot be found or if multiple matches are found without replaceAll
 */
export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
	if (oldString === newString) {
		throw new Error('No changes to apply: oldString and newString are identical.');
	}

	let notFound = true;

	for (const replacer of [
		SimpleReplacer,
		LineTrimmedReplacer,
		BlockAnchorReplacer,
		WhitespaceNormalizedReplacer,
		IndentationFlexibleReplacer,
		EscapeNormalizedReplacer,
		TrimmedBoundaryReplacer,
		ContextAwareReplacer,
		MultiOccurrenceReplacer,
	]) {
		for (const search of replacer(content, oldString)) {
			const index = content.indexOf(search);
			if (index === -1) continue;
			notFound = false;
			if (replaceAll) {
				return content.replaceAll(search, newString);
			}
			const lastIndex = content.lastIndexOf(search);
			if (index !== lastIndex) continue;
			return content.slice(0, index) + newString + content.slice(index + search.length);
		}
	}

	if (notFound) {
		throw new Error('Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.');
	}
	throw new Error('Found multiple matches for oldString. Provide more surrounding context to make the match unique.');
}
