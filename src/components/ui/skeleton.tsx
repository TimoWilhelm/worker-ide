import { cn } from '@/lib/utils';

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
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
				<Skeleton className="size-4 rounded-sm" />
				{label ? <span className="text-xs text-text-secondary">{label}</span> : <Skeleton className="h-4 w-24" />}
			</div>
			<div className="flex flex-1 flex-col gap-3 p-3">
				<Skeleton className="h-8 w-full rounded-md" />
				<div className="flex flex-col gap-2">
					{Array.from({ length: 4 }, (_, index) => (
						<Skeleton key={index} className="h-4" style={{ width: `${58 + ((index * 11) % 28)}%` }} />
					))}
				</div>
				<div className="mt-auto flex items-center justify-between gap-3 pt-2">
					<Skeleton className="h-4 w-20" />
					<Skeleton className="h-8 w-24 rounded-md" />
				</div>
			</div>
		</div>
	);
}

export function GitPanelSkeleton() {
	return (
		<div className="flex h-full flex-col bg-bg-secondary">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
				<Skeleton className="size-4 rounded-sm" />
				<Skeleton className="h-4 w-16" />
				<span className="flex-1" />
				<Skeleton className="h-6 w-14 rounded-md" />
			</div>
			<div className="flex flex-1 flex-col gap-2 p-3">
				{Array.from({ length: 5 }, (_, index) => (
					<div
						key={index}
						className="
							flex items-start gap-3 rounded-md border border-border/60 p-2.5
						"
					>
						<Skeleton className="mt-0.5 size-4 rounded-full" />
						<div className="flex min-w-0 flex-1 flex-col gap-2">
							<Skeleton className="h-4" style={{ width: `${55 + ((index * 9) % 25)}%` }} />
							<Skeleton className="h-3" style={{ width: `${34 + ((index * 13) % 22)}%` }} />
						</div>
						<Skeleton className="h-3 w-10 shrink-0" />
					</div>
				))}
			</div>
		</div>
	);
}

interface ListSkeletonProperties {
	itemCount?: number;
	className?: string;
	showLeadingIcon?: boolean;
}

export function ListSkeleton({ itemCount = 4, className, showLeadingIcon = true }: ListSkeletonProperties) {
	return (
		<div className={cn('flex flex-col gap-2', className)}>
			{Array.from({ length: itemCount }, (_, index) => (
				<div key={index} className="flex items-center gap-3 rounded-md border border-border/60 p-3">
					{showLeadingIcon ? <Skeleton className="size-8 shrink-0 rounded-full" /> : undefined}
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<Skeleton className="h-4" style={{ width: `${44 + ((index * 17) % 32)}%` }} />
						<Skeleton className="h-3" style={{ width: `${28 + ((index * 19) % 26)}%` }} />
					</div>
					<Skeleton className="h-8 w-20 shrink-0 rounded-md" />
				</div>
			))}
		</div>
	);
}

export function ModalContentSkeleton() {
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<Skeleton className="h-4 w-32" />
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-3/4" />
			</div>
			<div className="flex flex-col gap-2">
				{Array.from({ length: 2 }, (_, index) => (
					<div key={index} className="rounded-sm border border-border/60 p-3">
						<div className="flex items-start gap-2.5">
							<Skeleton className="mt-0.5 size-3.5 rounded-full" />
							<div className="flex flex-1 flex-col gap-1.5">
								<Skeleton className="h-4 w-24" />
								<Skeleton className="h-3 w-full" />
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export function AppLoadingSkeleton() {
	return (
		<div className="flex h-dvh flex-col bg-bg-primary">
			<div
				className="
					flex h-12 shrink-0 items-center justify-between border-b border-border
					bg-bg-secondary px-4
					sm:px-6
				"
			>
				<div className="flex items-center gap-3">
					<Skeleton className="size-8 rounded-md" />
					<Skeleton className="h-4 w-28" />
				</div>
				<div className="flex items-center gap-2">
					<Skeleton className="h-8 w-24 rounded-md" />
					<Skeleton className="size-8 rounded-full" />
				</div>
			</div>
			<div className="flex min-h-0 flex-1">
				<div
					className="
						hidden w-14 shrink-0 border-r border-border bg-bg-secondary/40
						lg:flex lg:flex-col lg:items-center lg:gap-3 lg:p-3
					"
				>
					{Array.from({ length: 5 }, (_, index) => (
						<Skeleton key={index} className="size-8 rounded-md" />
					))}
					<div className="mt-auto flex flex-col gap-3">
						<Skeleton className="size-8 rounded-full" />
						<Skeleton className="size-8 rounded-full" />
					</div>
				</div>
				<div
					className="
						flex min-h-0 flex-1 flex-col gap-5 p-4
						sm:p-6
					"
				>
					<div className="flex flex-col gap-2">
						<Skeleton className="h-7 w-40" />
						<Skeleton className="h-4 w-64 max-w-full" />
					</div>
					<div
						className="
							grid min-h-0 flex-1 gap-4
							lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]
						"
					>
						<div className="flex min-h-0 flex-col gap-4">
							<div className="rounded-xl border border-border bg-bg-secondary/40 p-4">
								<Skeleton className="mb-3 h-5 w-32 max-w-full" />
								<Skeleton
									className="
										h-40 rounded-xl
										sm:h-48
									"
								/>
							</div>
							<div className="rounded-xl border border-border bg-bg-secondary/40 p-4">
								<Skeleton className="mb-3 h-5 w-28" />
								<div className="flex flex-col gap-2">
									<Skeleton className="h-4 w-full" />
									<Skeleton className="h-4 w-5/6 max-w-full" />
									<Skeleton className="h-24 rounded-xl" />
								</div>
							</div>
						</div>
						<div className="flex flex-col gap-4">
							{Array.from({ length: 2 }, (_, index) => (
								<div key={index} className="rounded-xl border border-border bg-bg-secondary/40 p-4">
									<Skeleton className="mb-3 h-5 w-24" />
									<div className="flex flex-col gap-2">
										<Skeleton className="h-24 rounded-xl" />
										<Skeleton className="h-4 w-3/4 max-w-full" />
									</div>
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export function PreviewPanelSkeleton() {
	return (
		<div className="flex h-full flex-col bg-bg-secondary">
			<div
				className="
					flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border
					px-3
				"
			>
				<Skeleton className="h-4 w-16" />
				<div className="flex items-center gap-1.5">
					<Skeleton className="size-7 rounded-md" />
					<Skeleton className="size-7 rounded-md" />
					<Skeleton className="size-7 rounded-md" />
				</div>
			</div>
			<div className="flex flex-1 flex-col gap-3 p-3">
				<div
					className="
						flex items-center gap-2 rounded-lg border border-border/70 bg-bg-primary
						px-3 py-2
					"
				>
					<Skeleton className="size-2 rounded-full" />
					<Skeleton className="size-2 rounded-full" />
					<Skeleton className="size-2 rounded-full" />
					<Skeleton className="h-4 w-full rounded-full" />
				</div>
				<div
					className="
						flex flex-1 flex-col gap-4 rounded-xl border border-border/70
						bg-bg-primary p-4
					"
				>
					<Skeleton className="h-6 w-32 max-w-full rounded-md" />
					<div
						className="
							flex flex-col gap-3
							sm:flex-row
						"
					>
						<Skeleton className="h-20 flex-1 rounded-xl" />
						<Skeleton className="h-20 flex-1 rounded-xl" />
					</div>
					<Skeleton
						className="
							h-32 rounded-xl
							sm:h-40
						"
					/>
					<Skeleton className="min-h-0 flex-1 rounded-xl" />
				</div>
			</div>
		</div>
	);
}

export function DevelopmentToolsPanelSkeleton() {
	return (
		<div className="flex h-full flex-col bg-bg-secondary">
			<div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
				{Array.from({ length: 5 }, (_, index) => (
					<Skeleton key={index} className="size-8 rounded-md" />
				))}
			</div>
			<div
				className="
					flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border
					px-2
				"
			>
				<div className="flex items-center gap-1.5">
					<Skeleton className="size-5 rounded-sm" />
					<Skeleton className="h-4 w-16" />
				</div>
				<Skeleton className="h-4 w-24" />
			</div>
			<div
				className="
					flex min-h-0 flex-1 flex-col
					lg:flex-row
				"
			>
				<div
					className="
						flex shrink-0 flex-col gap-2 border-b border-border p-3
						lg:w-48 lg:border-r lg:border-b-0
					"
				>
					<Skeleton className="h-4 w-20" />
					{Array.from({ length: 5 }, (_, index) => (
						<Skeleton key={index} className="h-4" style={{ width: `${56 + ((index * 10) % 22)}%` }} />
					))}
				</div>
				<div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
					<div className="flex flex-wrap gap-2">
						<Skeleton className="h-5 w-20 rounded-sm" />
						<Skeleton className="h-5 w-20 rounded-sm" />
						<Skeleton className="h-5 w-16 rounded-sm" />
					</div>
					<Skeleton className="h-24 rounded-xl" />
					<div
						className="
							grid gap-3
							sm:grid-cols-2
						"
					>
						<Skeleton className="h-24 rounded-xl" />
						<Skeleton className="h-24 rounded-xl" />
					</div>
					<Skeleton className="min-h-0 flex-1 rounded-xl" />
				</div>
			</div>
		</div>
	);
}

export function AgentPanelSkeleton() {
	return (
		<div className="flex h-full flex-col bg-bg-secondary">
			<div
				className="
					flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border
					px-3
				"
			>
				<div className="flex items-center gap-2">
					<Skeleton className="size-6 rounded-md" />
					<Skeleton className="h-4 w-28" />
				</div>
				<div className="flex items-center gap-1.5">
					<Skeleton className="size-7 rounded-md" />
					<Skeleton className="size-7 rounded-md" />
				</div>
			</div>
			<div
				className="
					flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border
					px-3
				"
			>
				<div className="flex items-center gap-2">
					<Skeleton className="size-2 rounded-full" />
					<Skeleton className="h-3 w-24" />
				</div>
				<Skeleton className="size-5 rounded-md" />
			</div>
			<div className="flex flex-1 flex-col gap-3 overflow-hidden p-3">
				<div
					className="
						flex max-w-[88%] flex-col gap-2 rounded-2xl border border-border/70
						bg-bg-primary p-3
					"
				>
					<Skeleton className="h-4 w-40 max-w-full" />
					<Skeleton className="h-4 w-56 max-w-full" />
					<Skeleton className="h-4 w-32 max-w-full" />
				</div>
				<div className="flex justify-end">
					<div
						className="
							flex w-3/4 max-w-[80%] flex-col gap-2 rounded-2xl bg-bg-tertiary p-3
						"
					>
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-24 max-w-full" />
					</div>
				</div>
				<div
					className="
						flex max-w-[92%] flex-col gap-2 rounded-2xl border border-border/70
						bg-bg-primary p-3
					"
				>
					<Skeleton className="h-4 w-44 max-w-full" />
					<Skeleton className="h-24 rounded-xl" />
				</div>
				<div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
					<Skeleton className="h-16 rounded-xl" />
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-1.5">
							<Skeleton className="size-7 rounded-md" />
							<Skeleton className="size-7 rounded-md" />
						</div>
						<Skeleton className="h-8 w-20 rounded-md" />
					</div>
				</div>
			</div>
		</div>
	);
}

interface OutputPanelSkeletonProperties {
	showUtilityHeader?: boolean;
}

export function OutputPanelSkeleton({ showUtilityHeader = false }: OutputPanelSkeletonProperties) {
	return (
		<div className="flex h-full flex-col bg-bg-secondary">
			{showUtilityHeader ? (
				<div
					className="
						flex h-7 shrink-0 items-center justify-between gap-2 border-b
						border-border px-2
					"
				>
					<div className="flex items-center gap-2">
						<Skeleton className="size-4 rounded-sm" />
						<Skeleton className="h-4 w-16 rounded-full" />
					</div>
					<Skeleton className="h-4 w-12" />
				</div>
			) : undefined}
			<div
				className="
					flex shrink-0 items-center justify-between gap-2 border-b border-border
					px-2 py-1
				"
			>
				<div className="flex items-center gap-1.5">
					<Skeleton className="h-4 w-10 rounded-sm" />
					<Skeleton className="h-4 w-14 rounded-sm" />
					<Skeleton className="h-4 w-12 rounded-sm" />
				</div>
				<div className="flex items-center gap-1.5">
					<Skeleton className="h-4 w-14 rounded-sm" />
					<Skeleton className="size-5 rounded-sm" />
				</div>
			</div>
			<div className="flex flex-1 flex-col gap-2 px-3 py-2">
				{Array.from({ length: 8 }, (_, index) => (
					<div key={index} className="rounded-sm border border-transparent p-1">
						<div className="flex min-w-0 items-start gap-2">
							<Skeleton className="mt-1 size-1.5 shrink-0 rounded-full" />
							<div className="flex min-w-0 flex-1 flex-col gap-1.5">
								<Skeleton className="h-3" style={{ width: `${62 + ((index * 7) % 22)}%` }} />
								{index % 3 === 0 ? <Skeleton className="h-3" style={{ width: `${36 + ((index * 5) % 20)}%` }} /> : undefined}
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export function WranglerSettingsSkeleton() {
	return (
		<div className="flex h-full flex-col overflow-hidden bg-bg-secondary">
			<div
				className="
					flex shrink-0 items-center justify-between border-b border-border px-4
					py-2.5
				"
			>
				<div className="flex items-center gap-2">
					<Skeleton className="size-4 rounded-sm" />
					<Skeleton className="h-4 w-40" />
				</div>
				<div className="flex items-center gap-2">
					<Skeleton className="h-4 w-10" />
					<Skeleton className="h-8 w-20 rounded-md" />
				</div>
			</div>
			<div className="flex-1 overflow-y-auto p-4">
				<div className="mx-auto flex max-w-lg flex-col gap-5">
					<div className="flex flex-col gap-2">
						<Skeleton className="h-5 w-28" />
						<Skeleton className="h-4 w-full" />
					</div>
					{Array.from({ length: 3 }, (_, index) => (
						<section key={index} className="rounded-lg border border-border bg-bg-primary/40 p-4">
							<Skeleton className="mb-3 h-4 w-32 max-w-full" />
							<div className="flex flex-col gap-2">
								<Skeleton className="h-10 rounded-md" />
								<Skeleton className="h-3 w-56 max-w-full" />
								<Skeleton className="h-10 rounded-md" />
							</div>
						</section>
					))}
					<section className="rounded-lg border border-border bg-bg-primary/40 p-4">
						<div className="mb-3 flex items-center justify-between gap-3">
							<Skeleton className="h-4 w-28 max-w-full" />
							<Skeleton className="h-4 w-16" />
						</div>
						<Skeleton className="h-3 w-full rounded-full" />
					</section>
				</div>
			</div>
		</div>
	);
}

export function OrganizationManagementSkeleton() {
	return (
		<div className="flex h-dvh flex-col bg-bg-primary">
			<div
				className="
					flex h-12 shrink-0 items-center justify-between border-b border-border
					bg-bg-secondary px-4
					sm:px-6
				"
			>
				<div className="flex items-center gap-3">
					<Skeleton className="size-8 rounded-md" />
					<Skeleton className="h-4 w-28" />
				</div>
				<div className="flex items-center gap-2">
					<Skeleton className="h-8 w-32 rounded-md" />
					<Skeleton className="size-8 rounded-full" />
				</div>
			</div>
			<main className="flex-1 overflow-y-auto">
				<div
					className="
						mx-auto flex w-full max-w-lg flex-col gap-6 px-4 py-10
						sm:px-6 sm:py-12
					"
				>
					<div className="flex items-center gap-3">
						<Skeleton className="size-10 shrink-0 rounded-lg" />
						<div className="flex min-w-0 flex-1 flex-col gap-2">
							<Skeleton className="h-6 w-44 max-w-full" />
							<Skeleton className="h-3 w-32" />
							<Skeleton className="h-3 w-48 max-w-full" />
						</div>
						<Skeleton className="h-8 w-20 rounded-md" />
					</div>
					<section className="rounded-lg border border-border bg-bg-secondary/40 p-4">
						<Skeleton className="mb-4 h-4 w-36 max-w-full" />
						<div className="flex flex-col gap-3">
							{Array.from({ length: 3 }, (_, index) => (
								<div key={index} className={cn('flex items-center gap-3', index > 0 && 'border-t border-border pt-3')}>
									<Skeleton className="size-8 shrink-0 rounded-full" />
									<div className="flex min-w-0 flex-1 flex-col gap-1.5">
										<Skeleton className="h-4 w-32 max-w-full" />
										<Skeleton className="h-3 w-40 max-w-full" />
									</div>
									<Skeleton className="h-7 w-16 rounded-md" />
								</div>
							))}
						</div>
					</section>
					{Array.from({ length: 2 }, (_, index) => (
						<section key={index} className="rounded-lg border border-border bg-bg-secondary/40 p-4">
							<Skeleton className="mb-3 h-4 w-28 max-w-full" />
							<div className="flex flex-col gap-2">
								<Skeleton className="h-10 rounded-md" />
								<Skeleton className="h-3 w-48 max-w-full" />
								<Skeleton className="h-10 rounded-md" />
							</div>
						</section>
					))}
					<section className="rounded-lg border border-error/20 bg-bg-secondary/40 p-4">
						<div className="flex items-center justify-between gap-3">
							<div className="flex min-w-0 flex-col gap-1.5">
								<Skeleton className="h-4 w-32 max-w-full" />
								<Skeleton className="h-3 w-56 max-w-full" />
							</div>
							<Skeleton className="h-8 w-20 rounded-md" />
						</div>
					</section>
				</div>
			</main>
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
