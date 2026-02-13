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
