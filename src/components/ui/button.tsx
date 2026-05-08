import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

import { Spinner } from './spinner';

import type { ButtonHTMLAttributes, Ref } from 'react';

const buttonVariants = cva(
	`
		inline-flex cursor-pointer items-center justify-center gap-2 rounded-sm
		font-medium transition-colors
		disabled:pointer-events-none disabled:cursor-default disabled:opacity-50
	`,
	{
		variants: {
			focusStyle: {
				default: `
					focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
					focus-visible:ring-offset-bg-primary focus-visible:outline-none
				`,
				inset: `
					focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-offset-0
					focus-visible:outline-none focus-visible:ring-inset
				`,
			},
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
					bg-warning text-white
					hover:bg-yellow-700 hover:text-white
					dark:text-black
					dark:hover:bg-yellow-600 dark:hover:text-black
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
			focusStyle: 'default',
			variant: 'default',
			size: 'md',
		},
	},
);

interface ButtonProperties extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	isLoading?: boolean;
	ref?: Ref<HTMLButtonElement>;
}

/**
 * Button component with variants.
 * Uses React 19 ref-as-prop pattern (no forwardRef).
 */
function Button({ className, focusStyle, variant, size, isLoading, children, disabled, ref, ...properties }: ButtonProperties) {
	const isDisabledOrLoading = disabled || isLoading;

	return (
		<button
			data-local-focus="true"
			className={cn(buttonVariants({ focusStyle, variant, size, className }), isLoading && 'relative')}
			ref={ref}
			disabled={isDisabledOrLoading}
			{...properties}
		>
			<span className={cn('inline-flex items-center gap-2', isLoading && 'invisible')}>{children}</span>
			{isLoading && (
				<span className="absolute inset-0 flex items-center justify-center">
					<Spinner size="sm" />
				</span>
			)}
		</button>
	);
}

export { Button };
export type { ButtonProperties as ButtonProps };
