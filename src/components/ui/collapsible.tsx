import { AnimatePresence, motion } from 'motion/react';

import { springDefault } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

export interface CollapsibleProperties {
	open: boolean;
	children: ReactNode;
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
