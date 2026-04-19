import { sanitizePreviewElementReference } from '@shared/preview-element';

import type { PreviewElementReference } from '@shared/types';

export function serializePreviewElementReference(reference: PreviewElementReference): string {
	return encodeURIComponent(JSON.stringify(reference));
}

export function deserializePreviewElementReference(encodedReference: string): PreviewElementReference | undefined {
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(encodedReference));
		return sanitizePreviewElementReference(parsed);
	} catch {
		return undefined;
	}
}

export { type PreviewElementReference } from '@shared/types';
