import { ChevronDown, ChevronUp } from 'lucide-react';
import { lazy, Suspense } from 'react';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Pill } from '@/components/ui/pill';
import { PanelSkeleton } from '@/components/ui/skeleton';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import type { LogCounts } from '@/features/output';
import type { UtilityTab } from '@/lib/store';

const OutputPanel = lazy(() => import('@/features/output'));

interface TabDefinition {
	id: UtilityTab;
	label: string;
}

const TABS: TabDefinition[] = [{ id: 'output', label: 'Output' }];

export interface UtilityPanelProperties {
	projectId: string;
	onToggle: () => void;
	collapsed?: boolean;
	logCounts?: LogCounts;
	headerRight?: React.ReactNode;
	className?: string;
}

export function UtilityPanel({ projectId, onToggle, collapsed = false, logCounts, headerRight, className }: UtilityPanelProperties) {
	const activeTab = useStore((state) => state.activeUtilityTab);
	const showUtilityPanel = useStore((state) => state.showUtilityPanel);

	return (
		<div className={cn('flex flex-col overflow-hidden', !collapsed && 'h-full', className)}>
			<div
				onClick={onToggle}
				className="
					flex h-7 shrink-0 cursor-pointer items-center justify-between
					bg-bg-secondary px-2 transition-colors
					hover:bg-bg-tertiary
				"
			>
				<div className="flex shrink-0 items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
					<button
						type="button"
						onClick={onToggle}
						className="
							mr-1 flex cursor-pointer items-center justify-center rounded-sm p-0.5
							text-text-secondary transition-colors
							hover:text-text-primary
						"
						aria-label={collapsed ? 'Show utility panel' : 'Hide utility panel'}
					>
						{collapsed ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
					</button>

					<DropdownMenu>
						<DropdownMenuTrigger>
							<button type="button" className="flex cursor-pointer items-center gap-1.5">
								<Pill size="md" color="muted">
									{TABS.find((t) => t.id === activeTab)?.label}
								</Pill>
								{activeTab === 'output' && logCounts && (
									<>
										{logCounts.errors > 0 && <Pill color="red">{logCounts.errors}</Pill>}
										{logCounts.warnings > 0 && <Pill color="yellow">{logCounts.warnings}</Pill>}
									</>
								)}
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" sideOffset={4}>
							{TABS.map((tab) => (
								<DropdownMenuItem
									key={tab.id}
									aria-current={activeTab === tab.id ? 'true' : undefined}
									onSelect={() => showUtilityPanel(tab.id)}
								>
									{tab.label}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>

				{headerRight && <div className="flex min-w-0 items-center gap-2">{headerRight}</div>}
			</div>

			{!collapsed && (
				<div
					id={`utility-tabpanel-${activeTab}`}
					role="tabpanel"
					aria-label={TABS.find((t) => t.id === activeTab)?.label}
					className="flex-1 overflow-hidden"
				>
					{activeTab === 'output' && (
						<Suspense fallback={<PanelSkeleton label="Loading output..." />}>
							<OutputPanel projectId={projectId} className="h-full" />
						</Suspense>
					)}
				</div>
			)}
		</div>
	);
}
