/**
 * Button Component
 *
 * Versatile button with multiple variants and sizes.
 * Uses class-variance-authority for variant management.
 */

import { cva, type VariantProps } from 'class-variance-authority';

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
					bg-error text-white
					hover:bg-red-600
				`,
				outline: `
					border border-border bg-transparent text-text-primary
					hover:bg-bg-tertiary
				`,
			},
			size: {
				sm: 'h-7 px-2 text-xs',
				md: 'h-8 px-3 text-sm',
				lg: 'h-10 px-4 text-base',
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
	return (
		<button className={buttonVariants({ variant, size, className })} ref={ref} disabled={disabled || isLoading} {...properties}>
			{isLoading && <Spinner size="sm" />}
			{isLoading && loadingText ? loadingText : children}
		</button>
	);
}

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
export type { ButtonProperties as ButtonProps };
