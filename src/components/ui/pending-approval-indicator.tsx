import { cn } from '@/lib/utils';

import type { HTMLAttributes } from 'react';

export function PendingApprovalIndicator({ className, ...properties }: HTMLAttributes<HTMLSpanElement>) {
	return (
		<span aria-hidden="true" className={cn('relative inline-flex size-1.5 shrink-0', className)} {...properties}>
			<span className="absolute inset-0 animate-ping rounded-full bg-accent/30" />
			<span className="relative size-full rounded-full bg-accent" />
		</span>
	);
}
