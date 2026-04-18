export interface PreviewElementReference {
	selector: string;
	tagName: string;
}

const PREVIEW_ELEMENT_TOKEN_PREFIX = '[[preview-element:';
const PREVIEW_ELEMENT_TOKEN_SUFFIX = ']]';

export function normalizePreviewElementTagName(tagName: string): string {
	const normalizedTagName = tagName.trim().replaceAll(/[<>]/g, '').toLowerCase();
	return normalizedTagName || 'element';
}

export function getPreviewElementLabel(tagName: string): string {
	return `<${normalizePreviewElementTagName(tagName)}>`;
}

export function serializePreviewElementReference(reference: PreviewElementReference): string {
	return `${PREVIEW_ELEMENT_TOKEN_PREFIX}${getPreviewElementLabel(reference.tagName)}|${encodeURIComponent(reference.selector)}${PREVIEW_ELEMENT_TOKEN_SUFFIX}`;
}

export function deserializePreviewElementReference(label: string, encodedSelector: string): PreviewElementReference | undefined {
	try {
		const selector = decodeURIComponent(encodedSelector);
		if (!selector) {
			return undefined;
		}

		return {
			selector,
			tagName: normalizePreviewElementTagName(label),
		};
	} catch {
		return undefined;
	}
}
