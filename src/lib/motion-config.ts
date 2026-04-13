/**
 * Motion Library Configuration
 *
 * Shared spring presets, transition helpers, and reduced-motion utilities
 * for the `motion` animation library. All animation durations are kept
 * short (≤200ms effective) to avoid blocking productive use.
 */

import type { Transition } from 'motion/react';

// =============================================================================
// Spring Presets
// =============================================================================

/** Snappy spring for UI controls (buttons, pills, toggles). */
export const springSnappy: Transition = {
	type: 'spring',
	stiffness: 500,
	damping: 30,
};

/** Default spring for panels, modals, dropdowns. */
export const springDefault: Transition = {
	type: 'spring',
	stiffness: 400,
	damping: 28,
};

/** Critically-damped spring for drawers, zero overshoot. */
export const springCritical: Transition = {
	type: 'spring',
	stiffness: 600,
	damping: 45,
};

/** Gentle spring for page-level stagger entrances. */
export const springGentle: Transition = {
	type: 'spring',
	stiffness: 300,
	damping: 26,
};

// =============================================================================
// Transition Presets
// =============================================================================

/** Fast tween fallback for reduced-motion or non-spring contexts. */
export const tweenFast: Transition = {
	type: 'tween',
	duration: 0.15,
	ease: 'easeOut',
};

// =============================================================================
// Common Animation Variants
// =============================================================================

/** Overlay backdrop (modal, drawer, confirm dialog). */
export const overlayVariants = {
	hidden: { opacity: 0 },
	visible: { opacity: 1 },
	exit: { opacity: 0 },
};

/** Centered modal / dialog content. */
export const modalContentVariants = {
	hidden: { opacity: 0, scale: 0.96, y: 8 },
	visible: { opacity: 1, scale: 1, y: 0 },
	exit: { opacity: 0, scale: 0.96, y: 8 },
};

/** Dropdown / popover appearing from trigger. */
export const popoverVariants = {
	hidden: { opacity: 0, scale: 0.95, y: -4 },
	visible: { opacity: 1, scale: 1, y: 0 },
	exit: { opacity: 0, scale: 0.95, y: -4 },
};

/** Tooltip pop-in. */
export const tooltipVariants = {
	hidden: { opacity: 0, scale: 0.92 },
	visible: { opacity: 1, scale: 1 },
	exit: { opacity: 0, scale: 0.92 },
};

/** Slide from left (mobile drawer). */
export const slideLeftVariants = {
	hidden: { x: '-100%' },
	visible: { x: 0 },
	exit: { x: '-100%' },
};

/** Fade + slight upward shift for list items, chat messages. */
export const fadeUpVariants = {
	hidden: { opacity: 0, y: 6 },
	visible: { opacity: 1, y: 0 },
	exit: { opacity: 0, y: -4 },
};

/** Simple fade for status text, indicators. */
export const fadeVariants = {
	hidden: { opacity: 0 },
	visible: { opacity: 1 },
	exit: { opacity: 0 },
};

// =============================================================================
// Stagger Helpers
// =============================================================================

/** Container variant for staggered children. */
export function staggerContainer(staggerDelay = 0.04) {
	return {
		hidden: {},
		visible: {
			transition: {
				staggerChildren: staggerDelay,
			},
		},
	};
}
