/**
 * Tooltip Component
 *
 * Accessible tooltip using radix-ui primitives.
 * Wraps any trigger element with a styled tooltip on hover/focus.
 */

import { Tooltip as RadixTooltip } from 'radix-ui';

import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

interface TooltipProperties {
	/** The element that triggers the tooltip */
	children: ReactNode;
	/** Tooltip content text */
	content: string;
	/** Preferred side of the trigger to render on */
	side?: 'top' | 'right' | 'bottom' | 'left';
	/** Delay in ms before tooltip appears */
	delayDuration?: number;
	/** Additional class name for the tooltip content */
	className?: string;
}

function TooltipProvider({ children }: { children: ReactNode }) {
	return <RadixTooltip.Provider delayDuration={300}>{children}</RadixTooltip.Provider>;
}

function Tooltip({ children, content, side = 'top', delayDuration, className }: TooltipProperties) {
	return (
		<RadixTooltip.Root delayDuration={delayDuration}>
			<RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
			<RadixTooltip.Portal>
				<RadixTooltip.Content
					side={side}
					sideOffset={4}
					className={cn(
						`
							z-50 rounded-sm border border-border bg-bg-primary px-2 py-1 text-xs
							text-text-primary shadow-md
						`,
						className,
					)}
				>
					{content}
					<RadixTooltip.Arrow className="fill-border" />
				</RadixTooltip.Content>
			</RadixTooltip.Portal>
		</RadixTooltip.Root>
	);
}

export { Tooltip, TooltipProvider };
