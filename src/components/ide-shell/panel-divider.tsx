/**
 * Panel Divider — animated resize handle for react-resizable-panels.
 *
 * Renders a thin bar inside the library's Separator that expands and
 * recolors on hover / drag.
 *
 * The library tracks hover via pointermove on the PanelGroup container,
 * which misses leave events when the pointer crosses a scrollbar or
 * enters an iframe.  We work around this by:
 *  1. Listening to pointermove on `document` to hit-test the separator rect
 *     (fires even over scrollbars).
 *  2. Clearing on `window` blur (fires when an iframe captures focus).
 */

import { useCallback, useRef, useState } from 'react';
import { Separator } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

interface PanelDividerProperties {
	/** Orientation of the divider line (not the drag direction). */
	orientation: 'horizontal' | 'vertical';
}

export function PanelDivider({ orientation }: PanelDividerProperties) {
	const [isHighlighted, setIsHighlighted] = useState(false);
	const cleanupReference = useRef<(() => void) | undefined>(undefined);

	const separatorReference = useCallback((node: HTMLDivElement | null) => {
		// Tear down previous listeners
		cleanupReference.current?.();
		cleanupReference.current = undefined;
		if (!node) return;

		// Watch data-separator for the "active" (dragging) state only.
		const syncActive = () => {
			if (node.dataset.separator === 'active') {
				setIsHighlighted(true);
			} else if (node.dataset.separator !== 'hover') {
				// Attribute went to inactive — clear unless our own
				// pointermove will handle it on the next frame.
				setIsHighlighted(false);
			}
		};
		const observer = new MutationObserver(syncActive);
		observer.observe(node, { attributes: true, attributeFilter: ['data-separator'] });

		// Document-level pointermove: hit-test the separator's bounding rect.
		// This fires even when the pointer is over a scrollbar.
		const handlePointerMove = (event: PointerEvent) => {
			if (node.dataset.separator === 'active') return;
			const rect = node.getBoundingClientRect();
			const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
			setIsHighlighted(inside);
		};

		// When the pointer enters an iframe, the main window loses focus
		// and we stop receiving pointermove — force-clear.
		const handleWindowBlur = () => {
			if (node.dataset.separator !== 'active') {
				setIsHighlighted(false);
			}
		};

		document.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('blur', handleWindowBlur);

		cleanupReference.current = () => {
			observer.disconnect();
			document.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('blur', handleWindowBlur);
		};
	}, []);

	const isHorizontal = orientation === 'horizontal';

	return (
		<Separator
			elementRef={separatorReference}
			className={cn('relative flex items-center justify-center', isHorizontal ? 'w-[7px] cursor-col-resize' : 'h-[7px] cursor-row-resize')}
		>
			<div
				className={cn(
					'transition-[width,height,background-color] duration-100 ease-out',
					isHorizontal ? 'h-full w-0.5' : 'h-0.5 w-full',
					isHighlighted && cn('bg-accent', isHorizontal ? 'w-1' : 'h-1'),
					!isHighlighted && 'bg-border-solid',
				)}
			/>
		</Separator>
	);
}
