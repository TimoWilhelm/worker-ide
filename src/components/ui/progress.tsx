/**
 * Progress Component
 *
 * Accessible progress bar using Base UI primitives.
 * Styled with project design tokens (border, accent, bg-tertiary).
 */

import { Progress as BaseProgress } from '@base-ui/react/progress';

import { cn } from '@/lib/utils';

interface ProgressProperties {
	/** Current value (0–max). Pass `undefined` for indeterminate. */
	value: number | undefined;
	/** Maximum value. Defaults to 100. */
	max?: number;
	/** Additional class name for the root element. */
	className?: string;
	/** Additional class name for the track element. */
	trackClassName?: string;
	/** Additional class name for the indicator element. */
	indicatorClassName?: string;
}

function Progress({ value, max = 100, className, trackClassName, indicatorClassName }: ProgressProperties) {
	return (
		<BaseProgress.Root value={value ?? 0} max={max} className={cn('flex items-center', className)}>
			<BaseProgress.Track
				className={cn(
					`
						h-2 w-full min-w-12 overflow-hidden rounded-full border border-border
						bg-bg-tertiary
					`,
					trackClassName,
				)}
			>
				<BaseProgress.Indicator className={cn('h-full rounded-full bg-accent transition-all', indicatorClassName)} />
			</BaseProgress.Track>
		</BaseProgress.Root>
	);
}

export { Progress, type ProgressProperties };
