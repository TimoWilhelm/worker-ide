import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { springSnappy, tooltipVariants } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import type { ReactElement, ReactNode } from 'react';

// Registered once so each tooltip can read the latest interaction type before
// focus-triggered opens fire during mount (for example, dialog auto-focus).

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

// Touch users should only open tooltips after a deliberate long-press.

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

interface TooltipProperties {
	children: ReactElement<Record<string, unknown>>;
	content: string;
	side?: 'top' | 'right' | 'bottom' | 'left';
	delayDuration?: number;
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
