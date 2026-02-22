/**
 * Context Window Ring Indicator
 *
 * A small SVG ring that visually indicates how full the model's context window
 * currently is. Displayed next to the model selector pill.
 *
 * - Green: 0-69% utilization
 * - Yellow: 70-89% utilization (proactive pruning threshold)
 * - Red: 90%+ utilization (near overflow)
 *
 * Shows a tooltip with exact token counts on hover.
 */

import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// =============================================================================
// Constants
// =============================================================================

/** SVG ring dimensions */
const SIZE = 16;
const STROKE_WIDTH = 2;
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// =============================================================================
// Component
// =============================================================================

interface ContextRingProperties {
	/** Current token usage (cumulative input tokens) */
	tokensUsed: number;
	/** Maximum context window size in tokens */
	contextWindow: number;
	/** Additional class name */
	className?: string;
}

/**
 * Format a token count for display (e.g., 150000 -> "150K").
 */
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

	// Color based on utilization level
	const colorClass = utilization >= 0.9 ? 'text-error' : utilization >= 0.7 ? 'text-warning' : 'text-text-secondary';

	const tooltipContent = `Context: ${formatTokenCount(tokensUsed)} / ${formatTokenCount(contextWindow)} tokens (${Math.round(utilization * 100)}%)`;

	return (
		<Tooltip content={tooltipContent} side="top">
			<span className={cn('inline-flex items-center', className)}>
				<svg
					width={SIZE}
					height={SIZE}
					viewBox={`0 0 ${SIZE} ${SIZE}`}
					className={cn('shrink-0', colorClass)}
					aria-label={tooltipContent}
					role="img"
				>
					{/* Background track */}
					<circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="currentColor" strokeWidth={STROKE_WIDTH} opacity={0.2} />
					{/* Fill arc */}
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
