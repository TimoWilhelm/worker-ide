import { getPreviewElementDisplayText, previewElementToPromptText } from './preview-element';

import type { MessagePart } from './types';

function partToDisplayText(part: MessagePart): string {
	if (part.type === 'text') {
		return part.content;
	}

	if (part.type === 'preview-element') {
		return getPreviewElementDisplayText(part);
	}

	return '';
}

function partToPromptText(part: MessagePart): string {
	if (part.type === 'text') {
		return part.content;
	}

	if (part.type === 'preview-element') {
		return previewElementToPromptText(part);
	}

	return '';
}

export function messagePartsToPlainText(parts: readonly MessagePart[]): string {
	return parts.map((part) => partToDisplayText(part)).join('');
}

export function messagePartsToPromptText(parts: readonly MessagePart[]): string {
	return parts.map((part) => partToPromptText(part)).join('');
}

export function messagePartsHaveUserContent(parts: readonly MessagePart[]): boolean {
	return parts.some((part) => {
		if (part.type === 'preview-element' || part.type === 'image') {
			return true;
		}

		return part.type === 'text' && part.content.trim().length > 0;
	});
}
