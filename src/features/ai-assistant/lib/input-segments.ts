import {
	deserializePreviewElementReference,
	serializePreviewElementReference,
	type PreviewElementReference,
} from '@/lib/preview-element-reference';

export interface TextSegment {
	type: 'text';
	value: string;
}

export interface MentionSegment {
	type: 'mention';
	path: string;
}

export interface PreviewElementSegment extends PreviewElementReference {
	type: 'preview-element';
}

export type InputSegment = TextSegment | MentionSegment | PreviewElementSegment;

/**
 * Serialize segments to plain text (for sending to the AI).
 * Mentions become `@/path/to/file`.
 */
export function segmentsToPlainText(segments: InputSegment[]): string {
	return segments
		.map((segment) => {
			if (segment.type === 'mention') {
				return `@${segment.path}`;
			}

			if (segment.type === 'preview-element') {
				return serializePreviewElementReference(segment);
			}

			return segment.value;
		})
		.join('');
}

export function segmentsHaveContent(segments: InputSegment[]): boolean {
	return segments.some(
		(segment) =>
			segment.type === 'mention' || segment.type === 'preview-element' || (segment.type === 'text' && segment.value.trim().length > 0),
	);
}

/**
 * Regex to detect file mention patterns in plain text.
 * Matches `@` followed by a path starting with `/` and containing typical file path characters.
 * Stops at whitespace or end of string.
 */
const RICH_REFERENCE_PATTERN = /\[\[preview-element:(<[\w-]+>)\|([^\]]+)]]|@(\/[\w./-]+)/g;

/**
 * Parse plain text back into segments, detecting `@/path/to/file` patterns.
 * Only paths that exist in the `knownPaths` set are treated as mentions;
 * everything else stays as plain text.
 */
export function parseTextToSegments(text: string, knownPaths: ReadonlySet<string>): InputSegment[] {
	const segments: InputSegment[] = [];
	let lastIndex = 0;

	for (const match of text.matchAll(RICH_REFERENCE_PATTERN)) {
		const matchStart = match.index;
		const fullMatch = match[0];
		const previewElementLabel = match[1];
		const previewElementSelector = match[2];
		const path = match[3];

		if (previewElementLabel && previewElementSelector) {
			const previewElementReference = deserializePreviewElementReference(previewElementLabel, previewElementSelector);
			if (!previewElementReference) {
				continue;
			}

			if (matchStart > lastIndex) {
				segments.push({ type: 'text', value: text.slice(lastIndex, matchStart) });
			}

			segments.push({ type: 'preview-element', ...previewElementReference });
			lastIndex = matchStart + fullMatch.length;
			continue;
		}

		if (!path) {
			continue;
		}

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

export function appendPreviewElementSegment(segments: InputSegment[], reference: PreviewElementReference): InputSegment[] {
	const nextSegments = [...segments];
	const lastSegment = nextSegments.at(-1);

	if (lastSegment?.type === 'text' && lastSegment.value.length > 0 && !/\s$/.test(lastSegment.value)) {
		nextSegments[nextSegments.length - 1] = { type: 'text', value: `${lastSegment.value} ` };
	} else if (lastSegment && lastSegment.type !== 'text') {
		nextSegments.push({ type: 'text', value: ' ' });
	}

	nextSegments.push({ type: 'preview-element', ...reference });

	const trailingSegment = nextSegments.at(-1);
	if (trailingSegment?.type === 'preview-element') {
		nextSegments.push({ type: 'text', value: ' ' });
	}

	return nextSegments;
}

export function segmentsToDisplayText(segments: InputSegment[]): string {
	return segments
		.map((segment) => {
			if (segment.type === 'mention') {
				return `@${segment.path}`;
			}

			if (segment.type === 'preview-element') {
				return `<${segment.tagName}>`;
			}

			return segment.value;
		})
		.join('');
}
