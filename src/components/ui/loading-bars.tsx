import { motion } from 'motion/react';

import { cn } from '@/lib/utils';

const BAR_COUNT = 5;

interface LoadingBarsProperties {
	className?: string;
}

export function LoadingBars({ className }: LoadingBarsProperties) {
	return (
		<div className={cn('flex h-7 items-end gap-[3px]', className)} role="status" aria-label="Loading">
			{Array.from({ length: BAR_COUNT }, (_, index) => (
				<motion.div
					key={index}
					className="w-[3px] rounded-full bg-accent"
					animate={{
						height: [8 + index * 3, 16 + index * 2, 8 + index * 3],
						opacity: [0.3, 1, 0.3],
					}}
					transition={{ duration: 1, repeat: Infinity, delay: index * 0.12, ease: 'easeInOut' }}
					style={{ height: 8 + index * 3 }}
				/>
			))}
			<span className="sr-only">Loading...</span>
		</div>
	);
}
