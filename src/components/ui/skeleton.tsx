/**
 * Skeleton Component
 *
 * Animated placeholder for loading states.
 */

import { cn } from '@/lib/utils';

interface SkeletonProperties extends React.ComponentProps<'div'> {
	className?: string;
}

export function Skeleton({ className, ...rest }: SkeletonProperties) {
	return <div className={cn('animate-pulse rounded-md bg-bg-tertiary', className)} {...rest} />;
}

/**
 * Skeleton fallback for the file tree panel.
 */
export function FileTreeSkeleton() {
	return (
		<div className="flex flex-col gap-1 p-3">
			{Array.from({ length: 8 }, (_, index) => (
				<div key={index} className="flex items-center gap-2" style={{ paddingLeft: `${(index % 3) * 12 + 12}px` }}>
					<Skeleton className="size-4" />
					<Skeleton className="h-4" style={{ width: index % 2 === 0 ? '80px' : '112px' }} />
				</div>
			))}
		</div>
	);
}

/**
 * Skeleton fallback for the editor area.
 */
export function EditorSkeleton() {
	return (
		<div className="flex h-full flex-col gap-1.5 p-4">
			{Array.from({ length: 12 }, (_, index) => (
				<Skeleton
					key={index}
					className="h-4"
					style={{ width: `${30 + Math.floor(((index * 37) % 60) + 10)}%`, opacity: 0.4 + (index % 3) * 0.15 }}
				/>
			))}
		</div>
	);
}

/**
 * Skeleton fallback for a panel (AI, Preview, Terminal, Snapshots).
 */
export function PanelSkeleton({ label }: { label?: string }) {
	return (
		<div className="flex h-full flex-col bg-bg-secondary">
			<div className="flex h-9 shrink-0 items-center border-b border-border px-3">
				<Skeleton className="h-4 w-24" />
			</div>
			<div className="flex flex-1 flex-col items-center justify-center gap-3">
				<Skeleton className="size-6 rounded-full" />
				{label && <span className="text-xs text-text-secondary">{label}</span>}
			</div>
		</div>
	);
}

/**
 * Skeleton fallback for the git panel.
 */
export function GitPanelSkeleton() {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-4">
			<Skeleton className="size-8 rounded-full" />
			<Skeleton className="h-4 w-32" />
		</div>
	);
}
