import type { Transition } from 'motion/react';
export const springSnappy: Transition = {
	type: 'spring',
	stiffness: 500,
	damping: 30,
};
export const springDefault: Transition = {
	type: 'spring',
	stiffness: 400,
	damping: 28,
};
export const springCritical: Transition = {
	type: 'spring',
	stiffness: 600,
	damping: 45,
};
export const springGentle: Transition = {
	type: 'spring',
	stiffness: 300,
	damping: 26,
};
export const tweenFast: Transition = {
	type: 'tween',
	duration: 0.15,
	ease: 'easeOut',
};
export const modalContentVariants = {
	hidden: { opacity: 0, scale: 0.96, y: 8 },
	visible: { opacity: 1, scale: 1, y: 0 },
	exit: { opacity: 0, scale: 0.96, y: 8 },
};
export const popoverVariants = {
	hidden: { opacity: 0, scale: 0.95, y: -4 },
	visible: { opacity: 1, scale: 1, y: 0 },
	exit: { opacity: 0, scale: 0.95, y: -4 },
};
export const tooltipVariants = {
	hidden: { opacity: 0, scale: 0.92 },
	visible: { opacity: 1, scale: 1 },
	exit: { opacity: 0, scale: 0.92 },
};
export const slideLeftVariants = {
	hidden: { x: '-100%' },
	visible: { x: 0 },
	exit: { x: '-100%' },
};
export const fadeUpVariants = {
	hidden: { opacity: 0, y: 6 },
	visible: { opacity: 1, y: 0 },
	exit: { opacity: 0, y: -4 },
};
export const fadeVariants = {
	hidden: { opacity: 0 },
	visible: { opacity: 1 },
	exit: { opacity: 0 },
};
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
