/**
 * Button Component
 *
 * Versatile button with multiple variants and sizes.
 * Uses class-variance-authority for variant management.
 */

import { cva, type VariantProps } from 'class-variance-authority';
import { motion } from 'motion/react';

import { springSnappy } from '@/lib/motion-config';

import { Spinner } from './spinner';

import type { ButtonHTMLAttributes, Ref } from 'react';

const buttonVariants = cva(
	`
		inline-flex cursor-pointer items-center justify-center gap-2 rounded-sm
		font-medium transition-colors
		focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
		focus-visible:ring-offset-bg-primary focus-visible:outline-none
		disabled:pointer-events-none disabled:cursor-default disabled:opacity-50
	`,
	{
		variants: {
			variant: {
				default: `
					bg-accent text-white
					hover:bg-accent-hover
				`,
				secondary: `
					bg-bg-tertiary text-text-primary
					hover:bg-border
				`,
				ghost: `
					text-text-secondary
					hover:bg-bg-tertiary hover:text-text-primary
				`,
				danger: `
					bg-red-600 text-white
					hover:bg-red-700
				`,
				warning: `
					bg-warning text-black
					hover:bg-yellow-600 hover:text-black
				`,
				outline: `
					border border-border bg-transparent text-text-primary
					hover:bg-bg-tertiary
				`,
			},
			size: {
				sm: 'px-2 py-1.5 text-xs',
				md: 'px-3 py-1.5 text-sm',
				lg: 'px-4 py-2 text-base',
				icon: 'size-8',
				'icon-sm': 'size-6',
			},
		},
		defaultVariants: {
			variant: 'default',
			size: 'md',
		},
	},
);

interface ButtonProperties extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	/** Show loading spinner and disable button */
	isLoading?: boolean;
	/** Loading text to show instead of children */
	loadingText?: string;
	/** React 19 ref-as-prop */
	ref?: Ref<HTMLButtonElement>;
}

/**
 * Button component with variants.
 * Uses React 19 ref-as-prop pattern (no forwardRef).
 */
function Button({ className, variant, size, isLoading, loadingText, children, disabled, ref, ...properties }: ButtonProperties) {
	const isDisabledOrLoading = disabled || isLoading;

	return (
		<motion.div className="inline-flex" whileTap={isDisabledOrLoading ? undefined : { scale: 0.97 }} transition={springSnappy}>
			<button className={buttonVariants({ variant, size, className })} ref={ref} disabled={isDisabledOrLoading} {...properties}>
				{isLoading && <Spinner size="sm" />}
				{isLoading && loadingText ? loadingText : children}
			</button>
		</motion.div>
	);
}

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
export type { ButtonProperties as ButtonProps };
