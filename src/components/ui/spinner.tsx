import { cva, type VariantProps } from 'class-variance-authority';
import { motion } from 'motion/react';
import React from 'react';

import { cn } from '@/lib/utils';

const spinnerVariants = cva('text-current', {
	variants: {
		size: {
			xs: 'size-3',
			sm: 'size-4',
			md: 'size-6',
			lg: 'size-8',
			xl: 'size-12',
		},
	},
	defaultVariants: {
		size: 'md',
	},
});

export interface SpinnerProperties extends React.ComponentProps<typeof motion.svg>, VariantProps<typeof spinnerVariants> {
	className?: string;
}

const CUBIC_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];
export function Spinner({ size, className, ...properties }: SpinnerProperties) {
	return (
		<motion.svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={cn(spinnerVariants({ size }), className)}
			role="status"
			aria-label="Loading"
			animate={{ rotate: 360 }}
			transition={{ duration: 6, ease: 'linear', repeat: Infinity }}
			{...properties}
		>
			<g>
				<motion.path
					d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
					pathLength="100"
					strokeWidth="2.5"
					animate={{
						strokeDasharray: ['90 10', '56.6 43.4', '90 10', '56.6 43.4', '90 10', '56.6 43.4', '90 10'],
						strokeDashoffset: [0, -33.3, -33.3, -66.6, -66.6, -100, -100],
					}}
					transition={{
						duration: 3.3,
						times: [0, 0.166, 0.333, 0.5, 0.666, 0.833, 1],
						ease: [CUBIC_EASE, CUBIC_EASE, CUBIC_EASE, CUBIC_EASE, CUBIC_EASE, CUBIC_EASE],
						repeat: Infinity,
					}}
				/>
			</g>
			<span className="sr-only">Loading...</span>
		</motion.svg>
	);
}
