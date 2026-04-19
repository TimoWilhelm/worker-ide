import { WandSparkles } from 'lucide-react';
import { useCallback, useState } from 'react';

import { clearPreviewElementHighlight, revealPreviewElement, resolvePreviewElement } from '@/features/preview/preview-iframe-reference';
import { useIsMobile } from '@/hooks';
import { useStore } from '@/lib/store';
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
	const isMobile = useIsMobile();
	const setActiveMobilePanel = useStore((state) => state.setActiveMobilePanel);
	const [availability, setAvailability] = useState<'unknown' | 'available' | 'missing'>('unknown');
	const summary = getPreviewElementSummary(reference);

	const handleHighlight = useCallback(() => {
		revealPreviewElement(reference, { scroll: 'if-needed' });
	}, [reference]);

	const handleClearHighlight = useCallback(() => {
		clearPreviewElementHighlight();
	}, []);

	const handleClick = useCallback(() => {
		void (async () => {
			const found = await resolvePreviewElement(reference);
			if (found === undefined) {
				return;
			}

			setAvailability(found ? 'available' : 'missing');
			if (!found) {
				clearPreviewElementHighlight();
				return;
			}

			if (isMobile) {
				setActiveMobilePanel('preview');
				requestAnimationFrame(() => {
					revealPreviewElement(reference, { scroll: 'if-needed', sticky: true });
				});
				return;
			}

			revealPreviewElement(reference, { scroll: 'if-needed' });
		})();
	}, [isMobile, reference, setActiveMobilePanel]);

	const sharedClassName = cn(
		`
			inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden
			rounded-full px-2 py-1
		`,
		availability === 'missing' && 'line-through opacity-65',
		[
			'border border-fuchsia-200 bg-linear-to-r from-rose-50 via-amber-50 to-sky-50',
			'dark:border-fuchsia-950 dark:from-fuchsia-950 dark:via-violet-950 dark:to-sky-950',
		].join(' '),
		`
			font-mono text-xs font-semibold text-slate-900
			shadow-[0_0_0_1px_rgba(255,255,255,0.03)]
			dark:text-slate-50
		`,
		interactive &&
			[
				'transition-colors',
				'hover:from-rose-100 hover:via-amber-100 hover:to-sky-100',
				'dark:hover:from-fuchsia-900 dark:hover:via-violet-900 dark:hover:to-sky-900',
			].join(' '),
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
			onFocus={interactive && availability !== 'missing' ? handleHighlight : undefined}
			onBlur={interactive ? handleClearHighlight : undefined}
		>
			<WandSparkles className="size-3 shrink-0 text-fuchsia-700 dark:text-fuchsia-300" />
			<span className="truncate">{getPreviewElementLabel(reference.tagName)}</span>
			{summary && <span className="truncate opacity-70">{summary}</span>}
		</button>
	);
}
