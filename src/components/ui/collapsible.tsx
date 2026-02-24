/**
 * Collapsible
 *
 * Animates children in/out using a CSS grid-row height transition.
 * When `open` is false the element collapses to 0 height without
 * unmounting, preventing layout jumps that conditional rendering causes.
 */

import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

export interface CollapsibleProperties {
	/** Whether the content is visible */
	open: boolean;
	/** Content to show/hide */
	children: ReactNode;
	/** Extra classes on the outer grid wrapper */
	className?: string;
	/** Transition duration class (default: `duration-200`) */
	duration?: string;
}

export function Collapsible({ open, children, className, duration = 'duration-200' }: CollapsibleProperties) {
	return (
		<div className={cn('grid transition-[grid-template-rows] ease-out', duration, open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]', className)}>
			<div className="overflow-hidden">{children}</div>
		</div>
	);
}
