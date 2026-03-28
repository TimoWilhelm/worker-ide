/**
 * Collapsible
 *
 * Animates children in/out using a spring-based height transition
 * powered by the `motion` library. Uses AnimatePresence for clean
 * mount/unmount animations.
 */

import { AnimatePresence, motion } from 'motion/react';

import { springDefault } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

export interface CollapsibleProperties {
	/** Whether the content is visible */
	open: boolean;
	/** Content to show/hide */
	children: ReactNode;
	/** Extra classes on the wrapper */
	className?: string;
}

export function Collapsible({ open, children, className }: CollapsibleProperties) {
	return (
		<AnimatePresence initial={false}>
			{open && (
				<motion.div
					initial={{ height: 0, opacity: 0 }}
					animate={{ height: 'auto', opacity: 1 }}
					exit={{ height: 0, opacity: 0 }}
					transition={springDefault}
					className={cn('overflow-hidden', className)}
				>
					{children}
				</motion.div>
			)}
		</AnimatePresence>
	);
}
