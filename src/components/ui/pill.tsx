/**
 * Pill Component
 *
 * A small colored label used for status indicators, source badges, priority
 * tags, and mode selectors. Renders colored text on a tinted background with
 * automatic light/dark contrast.
 *
 * Uses class-variance-authority for variant management.
 */

import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

import type { HTMLAttributes, Ref } from 'react';

const pillVariants = cva('inline-flex items-center leading-none font-medium', {
	variants: {
		size: {
			xs: 'gap-0.5 px-1 py-px text-3xs',
			sm: 'gap-1 px-1.5 py-0.5 text-2xs',
			md: 'gap-1 px-2 py-0.5 text-xs',
		},
		rounded: {
			full: 'rounded-full',
			sm: 'rounded-sm',
		},
		color: {
			red: `
				bg-red-500/15 text-red-600
				dark:text-red-400
			`,
			yellow: `
				bg-yellow-500/15 text-yellow-600
				dark:text-yellow-400
			`,
			purple: `
				bg-purple-500/15 text-purple-600
				dark:text-purple-400
			`,
			cyan: `
				bg-cyan-500/15 text-cyan-600
				dark:text-cyan-400
			`,
			emerald: `
				bg-emerald-400/15 text-emerald-600
				dark:text-emerald-400
			`,
			amber: `
				bg-amber-400/15 text-amber-600
				dark:text-amber-400
			`,
			sky: `
				bg-sky-400/15 text-sky-600
				dark:text-sky-400
			`,
			success: 'bg-success/15 text-success',
			warning: 'bg-warning/15 text-warning',
			error: 'bg-error/15 text-error',
			muted: 'bg-bg-tertiary text-text-secondary',
		},
	},
	defaultVariants: {
		size: 'sm',
		rounded: 'full',
		color: 'muted',
	},
});

interface PillProperties extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'>, VariantProps<typeof pillVariants> {
	/** React 19 ref-as-prop */
	ref?: Ref<HTMLSpanElement>;
}

function Pill({ className, size, rounded, color, ref, ...properties }: PillProperties) {
	return <span className={cn(pillVariants({ size, rounded, color }), className)} ref={ref} {...properties} />;
}

// eslint-disable-next-line react-refresh/only-export-components
export { Pill, pillVariants };
export type { PillProperties };
