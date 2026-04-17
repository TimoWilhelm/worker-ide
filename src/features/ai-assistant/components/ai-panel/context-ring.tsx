import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const SIZE = 16;
const STROKE_WIDTH = 2;
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface ContextRingProperties {
	tokensUsed: number;
	contextWindow: number;
	className?: string;
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1000) {
		return `${Math.round(tokens / 1000)}K`;
	}
	return String(tokens);
}

export function ContextRing({ tokensUsed, contextWindow, className }: ContextRingProperties) {
	if (contextWindow === 0) return;

	const utilization = Math.min(tokensUsed / contextWindow, 1);
	const dashOffset = CIRCUMFERENCE * (1 - utilization);

	const colorClass = utilization >= 0.9 ? 'text-error' : utilization >= 0.7 ? 'text-warning' : 'text-text-secondary';

	const tooltipContent = `Context: ${formatTokenCount(tokensUsed)} / ${formatTokenCount(contextWindow)} tokens (${Math.round(utilization * 100)}%)`;

	return (
		<Tooltip content={tooltipContent} side="top">
			<span tabIndex={0} className={cn('inline-flex items-center p-1', className)}>
				<svg
					width={SIZE}
					height={SIZE}
					viewBox={`0 0 ${SIZE} ${SIZE}`}
					className={cn('shrink-0', colorClass)}
					aria-label={tooltipContent}
					role="img"
				>
					<circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="currentColor" strokeWidth={STROKE_WIDTH} opacity={0.2} />
					{utilization > 0 && (
						<circle
							cx={SIZE / 2}
							cy={SIZE / 2}
							r={RADIUS}
							fill="none"
							stroke="currentColor"
							strokeWidth={STROKE_WIDTH}
							strokeDasharray={CIRCUMFERENCE}
							strokeDashoffset={dashOffset}
							strokeLinecap="round"
							transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
							className="transition-[stroke-dashoffset] duration-300"
						/>
					)}
				</svg>
			</span>
		</Tooltip>
	);
}
