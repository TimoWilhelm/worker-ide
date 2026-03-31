import { cn } from '@/lib/utils';

interface BetaIndicatorProperties {
	className?: string;
}

export function BetaIndicator({ className }: BetaIndicatorProperties) {
	return (
		<span
			className={cn(
				`
					rounded-sm px-1 py-0.5 font-mono text-xs leading-none font-bold text-accent
				`,
				className,
			)}
			aria-label="Beta indicator"
		>
			&beta;
		</span>
	);
}
