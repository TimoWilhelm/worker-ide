/**
 * Typing Ellipsis
 *
 * Three dots that fade in sequentially like a typing ellipsis,
 * used as a "transcribing" indicator during speech-to-text.
 *
 * Uses motion/react with a gentle opacity-only animation —
 * no vertical movement — for a refined, understated feel.
 */

import { motion } from 'motion/react';

import { cn } from '@/lib/utils';

const DOT_TRANSITION = {
	duration: 1.2,
	repeat: Infinity,
	repeatType: 'mirror' as const,
	ease: 'easeInOut' as const,
};

export function BouncingDots({ className }: { className?: string }) {
	return (
		<span className={cn('inline-flex items-end gap-[2px]', className)} aria-label="Processing speech">
			{[0, 1, 2].map((index) => (
				<motion.span
					key={index}
					className="size-[3px] rounded-full bg-current"
					animate={{ opacity: [0.2, 0.8, 0.2] }}
					transition={{ ...DOT_TRANSITION, delay: index * 0.2 }}
				/>
			))}
		</span>
	);
}
