import { cn } from '@/lib/utils';

import { Spinner } from './spinner';

interface SkeletonProperties extends React.ComponentProps<'div'> {
	className?: string;
}

export function Skeleton({ className, ...rest }: SkeletonProperties) {
	return <div className={cn('animate-pulse rounded-md bg-bg-tertiary', className)} {...rest} />;
}
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
export function PanelSkeleton({ label }: { label?: string }) {
	return (
		<div className="flex h-full flex-col bg-bg-secondary">
			<div className="flex h-9 shrink-0 items-center border-b border-border px-3">
				<Skeleton className="h-4 w-24" />
			</div>
			<div className="flex flex-1 flex-col items-center justify-center gap-3">
				<Spinner />
				{label && <span className="text-xs text-text-secondary">{label}</span>}
			</div>
		</div>
	);
}
export function GitPanelSkeleton() {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-4">
			<Spinner size="sm" />
			<Skeleton className="h-4 w-32" />
		</div>
	);
}

/**
 * Lightweight skeleton for page-level content areas.
 *
 * Used as the Suspense fallback when lazy-loading route-level page
 * components. Renders a centered column of pulsing blocks that suggest
 * page content is loading — much lighter than a full-screen branded
 * spinner, and designed to sit inside a persistent layout shell.
 */
export function PageContentSkeleton() {
	return (
		<div
			className="
				flex h-dvh items-start justify-center bg-bg-primary pt-24
				sm:pt-32
			"
		>
			<div className="flex w-full max-w-lg flex-col gap-6 px-6">
				<div className="flex flex-col items-center gap-3">
					<Skeleton className="size-8 rounded-lg" />
					<Skeleton className="h-5 w-40" />
				</div>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-4 w-32" />
					<div
						className="
							grid grid-cols-3 gap-2
							sm:grid-cols-4
						"
					>
						{Array.from({ length: 4 }, (_, index) => (
							<Skeleton key={index} className="h-20 rounded-lg" />
						))}
					</div>
				</div>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-4 w-28" />
					<Skeleton className="h-12 rounded-lg" />
					<Skeleton className="h-12 rounded-lg" />
				</div>
			</div>
		</div>
	);
}

/**
 * Skeleton for the settings content area.
 *
 * Used inside the persistent SettingsLayout when lazy-loading individual
 * settings page components (profile, account, appearance).
 */
export function SettingsContentSkeleton() {
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<Skeleton className="h-6 w-32" />
				<Skeleton className="h-4 w-56" />
			</div>
			<div className="flex flex-col gap-4">
				{Array.from({ length: 3 }, (_, index) => (
					<div key={index} className="flex flex-col gap-2">
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-10 rounded-md" />
					</div>
				))}
			</div>
			<Skeleton className="h-9 w-24 rounded-md" />
		</div>
	);
}
