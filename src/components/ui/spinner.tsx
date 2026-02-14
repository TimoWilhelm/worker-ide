/**
 * Spinner Component
 *
 * Loading indicator with size variants.
 */

import { cva, type VariantProps } from 'class-variance-authority';

const spinnerVariants = cva('animate-spin rounded-full border-2 border-current border-t-transparent', {
	variants: {
		size: {
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

interface SpinnerProperties extends VariantProps<typeof spinnerVariants> {
	className?: string;
}

/**
 * Loading spinner component.
 */
export function Spinner({ size, className }: SpinnerProperties) {
	return (
		<div className={spinnerVariants({ size, className })} role="status" aria-label="Loading">
			<span className="sr-only">Loading...</span>
		</div>
	);
}
