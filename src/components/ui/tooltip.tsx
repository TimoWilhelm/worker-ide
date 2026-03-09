/**
 * Tooltip Component
 *
 * Accessible tooltip using radix-ui primitives.
 * Wraps any trigger element with a styled tooltip on hover/focus.
 *
 * On touch devices the tooltip is suppressed on normal taps and only shown
 * after a long-press (~700 ms). This prevents tooltips from covering
 * interactive elements during normal mobile use while keeping them
 * discoverable via long-press.
 */

import { Tooltip as RadixTooltip } from 'radix-ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

// =============================================================================
// Module-level touch tracker — registered once so every Tooltip instance can
// synchronously read whether the most recent interaction was touch.  Because
// this runs at module-evaluation time the flag is already correct when a
// freshly-mounted Tooltip receives a focus-triggered `onOpenChange(true)`
// (e.g. Radix Dialog auto-focus).
// =============================================================================

let lastInteractionWasTouch = false;

if (typeof document !== 'undefined') {
	document.addEventListener(
		'touchstart',
		() => {
			lastInteractionWasTouch = true;
		},
		{ passive: true, capture: true },
	);
	document.addEventListener(
		'pointermove',
		(event: PointerEvent) => {
			if (event.pointerType !== 'touch') {
				lastInteractionWasTouch = false;
			}
		},
		{ passive: true },
	);
}

// =============================================================================
// Long-press hook — provides controlled `open` / `onOpenChange` values that
// suppress touch-initiated opens unless preceded by a long-press.
// =============================================================================

const LONG_PRESS_DURATION = 700;

function useTouchGatedTooltip() {
	const [open, setOpen] = useState(false);
	const longPressTimerReference = useRef<ReturnType<typeof setTimeout>>(undefined);
	const longPressFiredReference = useRef(false);

	// Suppress opens that fire during mount (e.g. Radix Dialog auto-focus
	// landing on a tooltip trigger).  The flag flips to `true` one frame after
	// mount so that subsequent keyboard-tab focus still works normally.
	const mountedReference = useRef(false);
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			mountedReference.current = true;
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	// Long-press: start a timer on touchstart, cancel on touchend/touchmove.
	const onTriggerTouchStart = useCallback(() => {
		longPressFiredReference.current = false;
		longPressTimerReference.current = setTimeout(() => {
			longPressFiredReference.current = true;
			setOpen(true);
		}, LONG_PRESS_DURATION);
	}, []);

	const cancelLongPress = useCallback(() => {
		clearTimeout(longPressTimerReference.current);
	}, []);

	// Cleanup on unmount.
	useEffect(() => {
		return () => clearTimeout(longPressTimerReference.current);
	}, []);

	const onOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (nextOpen) {
				// Block opens that fire before the component has been interactive
				// for at least one frame (auto-focus from dialogs / drawers).
				if (!mountedReference.current) return;

				// Allow open if:
				// - The interaction is NOT touch (normal mouse/keyboard), OR
				// - A long-press just fired on *this* trigger.
				if (!lastInteractionWasTouch || longPressFiredReference.current) {
					setOpen(true);
				}
				// Otherwise swallow the open request.
			} else {
				longPressFiredReference.current = false;
				setOpen(false);
			}
		},
		[setOpen],
	);

	return { open, onOpenChange, onTriggerTouchStart, cancelLongPress };
}

// =============================================================================
// Components
// =============================================================================

interface TooltipProperties {
	/** The element that triggers the tooltip */
	children: ReactNode;
	/** Tooltip content text */
	content: string;
	/** Preferred side of the trigger to render on */
	side?: 'top' | 'right' | 'bottom' | 'left';
	/** Delay in ms before tooltip appears */
	delayDuration?: number;
	/** Additional class name for the tooltip content */
	className?: string;
}

function TooltipProvider({ children }: { children: ReactNode }) {
	return <RadixTooltip.Provider delayDuration={300}>{children}</RadixTooltip.Provider>;
}

function Tooltip({ children, content, side = 'top', delayDuration, className }: TooltipProperties) {
	const { open, onOpenChange, onTriggerTouchStart, cancelLongPress } = useTouchGatedTooltip();

	return (
		<RadixTooltip.Root open={open} onOpenChange={onOpenChange} delayDuration={delayDuration}>
			<RadixTooltip.Trigger asChild onTouchStart={onTriggerTouchStart} onTouchEnd={cancelLongPress} onTouchMove={cancelLongPress}>
				{children}
			</RadixTooltip.Trigger>
			<RadixTooltip.Portal>
				<RadixTooltip.Content
					side={side}
					sideOffset={4}
					className={cn(
						`
							z-50 rounded-sm border border-border bg-bg-primary px-2 py-1 text-xs
							text-text-primary shadow-md
						`,
						className,
					)}
				>
					{content}
					<RadixTooltip.Arrow className="fill-border" />
				</RadixTooltip.Content>
			</RadixTooltip.Portal>
		</RadixTooltip.Root>
	);
}

export { Tooltip, TooltipProvider };
