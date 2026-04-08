/**
 * Tooltip Component
 *
 * Accessible tooltip using Base UI primitives.
 * Wraps any trigger element with a styled tooltip on hover/focus.
 *
 * On touch devices the tooltip is suppressed on normal taps and only shown
 * after a long-press (~700 ms). This prevents tooltips from covering
 * interactive elements during normal mobile use while keeping them
 * discoverable via long-press.
 */

import { Tooltip as BaseTooltip } from '@base-ui-components/react/tooltip';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { springSnappy, tooltipVariants } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import type { ReactElement, ReactNode } from 'react';

// =============================================================================
// Module-level touch tracker — registered once so every Tooltip instance can
// synchronously read whether the most recent interaction was touch.  Because
// this runs at module-evaluation time the flag is already correct when a
// freshly-mounted Tooltip receives a focus-triggered `onOpenChange(true)`
// (e.g. Dialog auto-focus).
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

	// Suppress opens that fire during mount (e.g. Dialog auto-focus
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
		(nextOpen: boolean, _eventDetails?: unknown) => {
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
	children: ReactElement<Record<string, unknown>>;
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
	return <BaseTooltip.Provider delay={300}>{children}</BaseTooltip.Provider>;
}

function Tooltip({ children, content, side = 'top', delayDuration, className }: TooltipProperties) {
	const { open, onOpenChange, onTriggerTouchStart, cancelLongPress } = useTouchGatedTooltip();

	return (
		<BaseTooltip.Root open={open} onOpenChange={onOpenChange}>
			<BaseTooltip.Trigger
				delay={delayDuration}
				onTouchStart={onTriggerTouchStart}
				onTouchEnd={cancelLongPress}
				onTouchMove={cancelLongPress}
				render={children}
			/>
			<AnimatePresence>
				{open && (
					<BaseTooltip.Portal keepMounted>
						<BaseTooltip.Positioner side={side} sideOffset={4}>
							<BaseTooltip.Popup
								role="tooltip"
								render={<motion.div variants={tooltipVariants} initial="hidden" animate="visible" exit="exit" transition={springSnappy} />}
								className={cn(
									`
										z-50 rounded-sm border border-border bg-bg-primary px-2 py-1 text-xs
										text-text-primary shadow-md
									`,
									className,
								)}
							>
								{content}
								<BaseTooltip.Arrow className="fill-border" />
							</BaseTooltip.Popup>
						</BaseTooltip.Positioner>
					</BaseTooltip.Portal>
				)}
			</AnimatePresence>
		</BaseTooltip.Root>
	);
}

export { Tooltip, TooltipProvider };
