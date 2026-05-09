import { getPreviewElementDisplayText } from '@shared/preview-element';

import type { MessagePart, PreviewElementPart, PreviewElementReference, TextPart } from '@shared/types';

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

const FILE_REFERENCE_PATTERN = /@(\/[-\w./]+)/g;

function pushTextSegment(segments: InputSegment[], value: string): void {
	if (!value) {
		return;
	}

	const lastSegment = segments.at(-1);
	if (lastSegment?.type === 'text') {
		lastSegment.value += value;
		return;
	}

	segments.push({ type: 'text', value });
}

function pushMessageTextParts(parts: Array<TextPart | PreviewElementPart>, value: string): void {
	if (!value) {
		return;
	}

	const lastPart = parts.at(-1);
	if (lastPart?.type === 'text') {
		lastPart.content += value;
		return;
	}

	parts.push({ type: 'text', content: value });
}

export function segmentsToPlainText(segments: InputSegment[]): string {
	return segments
		.map((segment) => {
			if (segment.type === 'mention') {
				return `@${segment.path}`;
			}

			if (segment.type === 'preview-element') {
				return getPreviewElementDisplayText(segment);
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

export function parseTextToSegments(text: string, knownPaths: ReadonlySet<string>): InputSegment[] {
	const segments: InputSegment[] = [];
	let lastIndex = 0;

	for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
		const matchStart = match.index;
		const fullMatch = match[0];
		const path = match[1];
		if (matchStart === undefined || !path || !knownPaths.has(path)) {
			continue;
		}

		if (matchStart > lastIndex) {
			pushTextSegment(segments, text.slice(lastIndex, matchStart));
		}

		segments.push({ type: 'mention', path });
		lastIndex = matchStart + fullMatch.length;
	}

	if (lastIndex < text.length) {
		pushTextSegment(segments, text.slice(lastIndex));
	}

	return segments;
}

export function messagePartsToInputSegments(parts: readonly MessagePart[], knownPaths: ReadonlySet<string>): InputSegment[] {
	const segments: InputSegment[] = [];

	for (const part of parts) {
		if (part.type === 'text') {
			for (const segment of parseTextToSegments(part.content, knownPaths)) {
				if (segment.type === 'text') {
					pushTextSegment(segments, segment.value);
					continue;
				}

				segments.push(segment);
			}
			continue;
		}

		if (part.type === 'preview-element') {
			segments.push(part);
		}
	}

	return segments;
}

export function segmentsToMessageParts(segments: InputSegment[]): Array<TextPart | PreviewElementPart> {
	const parts: Array<TextPart | PreviewElementPart> = [];

	for (const segment of segments) {
		if (segment.type === 'text') {
			pushMessageTextParts(parts, segment.value);
			continue;
		}

		if (segment.type === 'mention') {
			pushMessageTextParts(parts, `@${segment.path}`);
			continue;
		}

		parts.push(segment);
	}

	return parts;
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
