import { WandSparkles } from 'lucide-react';
import { useCallback, useState } from 'react';

import {
	clearPreviewElementHighlight,
	highlightPreviewElement,
	revealPreviewElement,
	resolvePreviewElement,
} from '@/features/preview/preview-iframe-reference';
import { useIsMobile } from '@/hooks';
import { getPreviewElementLabel } from '@/lib/preview-element-reference';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

export function PreviewElementReference({
	selector,
	tagName,
	className,
	interactive = true,
}: {
	selector: string;
	tagName: string;
	className?: string;
	interactive?: boolean;
}) {
	const isMobile = useIsMobile();
	const setActiveMobilePanel = useStore((state) => state.setActiveMobilePanel);
	const [availability, setAvailability] = useState<'unknown' | 'available' | 'missing'>('unknown');

	const handleHighlight = useCallback(() => {
		highlightPreviewElement(selector);
	}, [selector]);

	const handleClearHighlight = useCallback(() => {
		clearPreviewElementHighlight();
	}, []);

	const handleClick = useCallback(() => {
		void (async () => {
			const found = await resolvePreviewElement(selector);
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
					revealPreviewElement(selector);
				});
				return;
			}

			revealPreviewElement(selector);
		})();
	}, [isMobile, selector, setActiveMobilePanel]);

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
			aria-label={`${getPreviewElementLabel(tagName)} ${selector}`}
			onClick={handleClick}
			onMouseEnter={interactive && !isMobile && availability !== 'missing' ? handleHighlight : undefined}
			onMouseLeave={interactive && !isMobile ? handleClearHighlight : undefined}
			onFocus={interactive && availability !== 'missing' ? handleHighlight : undefined}
			onBlur={interactive ? handleClearHighlight : undefined}
		>
			<WandSparkles className="size-3 shrink-0 text-fuchsia-700 dark:text-fuchsia-300" />
			<span className="truncate">{getPreviewElementLabel(tagName)}</span>
		</button>
	);
}
