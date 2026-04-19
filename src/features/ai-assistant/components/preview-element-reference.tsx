import { WandSparkles } from 'lucide-react';
import { useCallback, useState } from 'react';

import { usePreviewReferenceInteractions } from '@/features/ai-assistant/lib/reference-actions';
import {
	PREVIEW_REFERENCE_BASE_CLASS_NAME,
	PREVIEW_REFERENCE_ICON_CLASS_NAME,
	PREVIEW_REFERENCE_INTERACTIVE_CLASS_NAME,
	PREVIEW_REFERENCE_LABEL_CLASS_NAME,
	PREVIEW_REFERENCE_SUMMARY_CLASS_NAME,
	PREVIEW_REFERENCE_TEXT_ROW_CLASS_NAME,
} from '@/features/ai-assistant/lib/reference-pill-styles';
import { cn } from '@/lib/utils';
import { getPreviewElementDisplayText, getPreviewElementLabel, getPreviewElementSummary } from '@shared/preview-element';

import type { PreviewElementReference as PreviewElementReferenceValue } from '@shared/types';

export function PreviewElementReference({
	reference,
	className,
	interactive = true,
}: {
	reference: PreviewElementReferenceValue;
	className?: string;
	interactive?: boolean;
}) {
	const { activateReference, clearReferenceHighlight, hoverReference, isMobile } = usePreviewReferenceInteractions();
	const [availability, setAvailability] = useState<'unknown' | 'available' | 'missing'>('unknown');
	const summary = getPreviewElementSummary(reference);

	const handleHighlight = useCallback(() => {
		hoverReference(reference);
	}, [hoverReference, reference]);

	const handleClearHighlight = useCallback(() => {
		clearReferenceHighlight();
	}, [clearReferenceHighlight]);

	const handleClick = useCallback(() => {
		activateReference(reference, (found) => {
			setAvailability(found ? 'available' : 'missing');
		});
	}, [activateReference, reference]);

	const sharedClassName = cn(
		PREVIEW_REFERENCE_BASE_CLASS_NAME,
		availability === 'missing' && 'line-through opacity-65',
		interactive && PREVIEW_REFERENCE_INTERACTIVE_CLASS_NAME,
		interactive && (isMobile ? 'cursor-pointer' : 'cursor-default'),
		className,
	);

	return (
		<button
			type="button"
			className={sharedClassName}
			aria-label={getPreviewElementDisplayText(reference)}
			onClick={handleClick}
			onMouseEnter={interactive && !isMobile && availability !== 'missing' ? handleHighlight : undefined}
			onMouseLeave={interactive && !isMobile ? handleClearHighlight : undefined}
			onFocus={interactive && !isMobile && availability !== 'missing' ? handleHighlight : undefined}
			onBlur={interactive && !isMobile ? handleClearHighlight : undefined}
		>
			<WandSparkles className={PREVIEW_REFERENCE_ICON_CLASS_NAME} />
			<span className={PREVIEW_REFERENCE_TEXT_ROW_CLASS_NAME}>
				<span className={PREVIEW_REFERENCE_LABEL_CLASS_NAME}>{getPreviewElementLabel(reference.tagName)}</span>
				{summary && <span className={PREVIEW_REFERENCE_SUMMARY_CLASS_NAME}>{summary}</span>}
			</span>
		</button>
	);
}
