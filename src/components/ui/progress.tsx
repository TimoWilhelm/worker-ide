import { Progress as BaseProgress } from '@base-ui/react/progress';

import { cn } from '@/lib/utils';

interface ProgressProperties {
	value: number | undefined;
	max?: number;
	className?: string;
	trackClassName?: string;
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
