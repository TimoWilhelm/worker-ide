/**
 * Input Segment utilities
 *
 * Types and helper functions for the rich text input model.
 * Segments represent a mix of plain text and file mention pills.
 */

// =============================================================================
// Types
// =============================================================================

export interface TextSegment {
	type: 'text';
	value: string;
}

export interface MentionSegment {
	type: 'mention';
	path: string;
}

export type InputSegment = TextSegment | MentionSegment;

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serialize segments to plain text (for sending to the AI).
 * Mentions become `@/path/to/file`.
 */
export function segmentsToPlainText(segments: InputSegment[]): string {
	return segments.map((segment) => (segment.type === 'mention' ? `@${segment.path}` : segment.value)).join('');
}

/**
 * Check if segments have any non-whitespace content.
 */
export function segmentsHaveContent(segments: InputSegment[]): boolean {
	return segments.some((segment) => segment.type === 'mention' || (segment.type === 'text' && segment.value.trim().length > 0));
}

// =============================================================================
// Parsing
// =============================================================================

/**
 * Regex to detect file mention patterns in plain text.
 * Matches `@` followed by a path starting with `/` and containing typical file path characters.
 * Stops at whitespace or end of string.
 */
const FILE_MENTION_PATTERN = /@(\/[\w./-]+)/g;

/**
 * Parse plain text back into segments, detecting `@/path/to/file` patterns.
 * Only paths that exist in the `knownPaths` set are treated as mentions;
 * everything else stays as plain text.
 */
export function parseTextToSegments(text: string, knownPaths: ReadonlySet<string>): InputSegment[] {
	const segments: InputSegment[] = [];
	let lastIndex = 0;

	for (const match of text.matchAll(FILE_MENTION_PATTERN)) {
		const matchStart = match.index;
		const fullMatch = match[0]; // e.g. "@/src/main.ts"
		const path = match[1]; // e.g. "/src/main.ts"

		if (!knownPaths.has(path)) {
			// Not a known file — skip, will be included as plain text
			continue;
		}

		// Push preceding plain text
		if (matchStart > lastIndex) {
			segments.push({ type: 'text', value: text.slice(lastIndex, matchStart) });
		}

		segments.push({ type: 'mention', path });
		lastIndex = matchStart + fullMatch.length;
	}

	// Push trailing plain text
	if (lastIndex < text.length) {
		segments.push({ type: 'text', value: text.slice(lastIndex) });
	}

	return segments;
}
