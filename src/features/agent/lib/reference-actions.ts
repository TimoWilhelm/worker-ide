import { useCallback } from 'react';

import { clearPreviewElementHighlight, revealPreviewElement, resolvePreviewElement } from '@/features/preview/preview-iframe-reference';
import { useIsMobile } from '@/hooks';
import { useStore, type MobilePanel } from '@/lib/store';

import type { PreviewElementReference } from '@shared/types';

interface PreviewReferenceActivationOptions {
	isMobile: boolean;
	reference: PreviewElementReference;
	setActiveMobilePanel: (panel: MobilePanel) => void;
	onResolved?: (found: boolean) => void;
}

function hoverPreviewReference(reference: PreviewElementReference): void {
	revealPreviewElement(reference, { scroll: 'if-needed' });
}

function clearPreviewReferenceHighlight(): void {
	clearPreviewElementHighlight();
}

async function activatePreviewReference({
	isMobile,
	reference,
	setActiveMobilePanel,
	onResolved,
}: PreviewReferenceActivationOptions): Promise<void> {
	if (isMobile) {
		setActiveMobilePanel('preview');
		requestAnimationFrame(() => {
			revealPreviewElement(reference, { scroll: 'if-needed', sticky: true });
			void resolvePreviewElement(reference).then((found) => {
				if (found === undefined) {
					return;
				}

				onResolved?.(found);
				if (!found) {
					clearPreviewElementHighlight();
					return;
				}

				revealPreviewElement(reference, { scroll: 'if-needed', sticky: true });
			});
		});
		return;
	}

	const found = await resolvePreviewElement(reference);
	if (found === undefined) {
		return;
	}

	onResolved?.(found);
	if (!found) {
		clearPreviewElementHighlight();
		return;
	}

	hoverPreviewReference(reference);
}

export function usePreviewReferenceInteractions(): {
	isMobile: boolean;
	activateReference: (reference: PreviewElementReference, onResolved?: (found: boolean) => void) => void;
	clearReferenceHighlight: () => void;
	hoverReference: (reference: PreviewElementReference) => void;
} {
	const isMobile = useIsMobile();
	const setActiveMobilePanel = useStore((state) => state.setActiveMobilePanel);

	const hoverReference = useCallback((reference: PreviewElementReference) => {
		hoverPreviewReference(reference);
	}, []);

	const clearReferenceHighlight = useCallback(() => {
		clearPreviewReferenceHighlight();
	}, []);

	const activateReference = useCallback(
		(reference: PreviewElementReference, onResolved?: (found: boolean) => void) => {
			void activatePreviewReference({ isMobile, reference, setActiveMobilePanel, onResolved });
		},
		[isMobile, setActiveMobilePanel],
	);

	return {
		isMobile,
		activateReference,
		clearReferenceHighlight,
		hoverReference,
	};
}
