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

const pillVariants = cva(
	`
		inline-flex items-center border border-transparent leading-none font-medium
		transition-colors select-none
	`,
	{
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
					hover:border-red-500/40 hover:text-red-700
					dark:text-red-400
					dark:hover:text-red-300
				`,
				yellow: `
					bg-yellow-500/15 text-yellow-600
					hover:border-yellow-500/40 hover:text-yellow-700
					dark:text-yellow-400
					dark:hover:text-yellow-300
				`,
				purple: `
					bg-purple-500/15 text-purple-600
					hover:border-purple-500/40 hover:text-purple-700
					dark:text-purple-400
					dark:hover:text-purple-300
				`,
				cyan: `
					bg-cyan-500/15 text-cyan-600
					hover:border-cyan-500/40 hover:text-cyan-700
					dark:text-cyan-400
					dark:hover:text-cyan-300
				`,
				emerald: `
					bg-emerald-400/15 text-emerald-600
					hover:border-emerald-400/40 hover:text-emerald-700
					dark:text-emerald-400
					dark:hover:text-emerald-300
				`,
				amber: `
					bg-amber-400/15 text-amber-600
					hover:border-amber-400/40 hover:text-amber-700
					dark:text-amber-400
					dark:hover:text-amber-300
				`,
				sky: `
					bg-sky-400/15 text-sky-600
					hover:border-sky-400/40 hover:text-sky-700
					dark:text-sky-400
					dark:hover:text-sky-300
				`,
				success: 'bg-success/15 text-success hover:border-success/40 hover:brightness-125',
				warning: 'bg-warning/15 text-warning hover:border-warning/40 hover:brightness-125',
				error: `
					bg-error/15 text-error
					hover:border-error/40 hover:brightness-125
				`,
				muted: `
					bg-bg-tertiary text-text-secondary
					hover:border-text-secondary/30 hover:text-text-primary
				`,
			},
		},
		defaultVariants: {
			size: 'sm',
			rounded: 'full',
			color: 'muted',
		},
	},
);

interface PillProperties extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'>, VariantProps<typeof pillVariants> {
	/** React 19 ref-as-prop */
	ref?: Ref<HTMLSpanElement>;
}

function Pill({ className, size, rounded, color, ref, ...properties }: PillProperties) {
	return <span className={cn(pillVariants({ size, rounded, color }), className)} ref={ref} {...properties} />;
}

export { Pill };
export type { PillProperties };
