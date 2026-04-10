/**
 * Utility Panel Component
 *
 * A tabbed container shell for the bottom panel area of the IDE.
 * Currently hosts the Output sub-panel; designed to support additional
 * panel types (Terminal, Debug Console, etc.) in the future.
 *
 * Owns its own header row: chevron toggle + tab buttons (with inline
 * badges) + optional right-side status content.
 */

import { ChevronDown, ChevronUp } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Pill } from '@/components/ui/pill';
import { PanelSkeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import type { LogCounts } from '@/features/output';

// Lazy-loaded sub-panels for code splitting
const OutputPanel = lazy(() => import('@/features/output'));

// =============================================================================
// Types
// =============================================================================

/** Available utility panel tabs */
type UtilityTab = 'output';

interface TabDefinition {
	id: UtilityTab;
	label: string;
}

const TABS: TabDefinition[] = [{ id: 'output', label: 'Output' }];

export interface UtilityPanelProperties {
	/** Project ID passed down to sub-panels */
	projectId: string;
	/** Called when the user clicks the header to collapse the panel */
	onToggle: () => void;
	/** Whether the panel body is collapsed (header still visible) */
	collapsed?: boolean;
	/** Log counts to display as badges on the Output tab */
	logCounts?: LogCounts;
	/** Optional content rendered on the right side of the header (status bar, etc.) */
	headerRight?: React.ReactNode;
	/** CSS class name */
	className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function UtilityPanel({ projectId, onToggle, collapsed = false, logCounts, headerRight, className }: UtilityPanelProperties) {
	const [activeTab, setActiveTab] = useState<UtilityTab>('output');

	return (
		<div className={cn('flex flex-col overflow-hidden', !collapsed && 'h-full', className)}>
			{/* Combined header: clicking the bar collapses the panel */}
			<div
				onClick={onToggle}
				className="
					flex h-7 shrink-0 cursor-pointer items-center justify-between
					bg-bg-secondary px-2 transition-colors
					hover:bg-bg-tertiary
				"
			>
				{/* Left: chevron + tabs */}
				<div className="flex shrink-0 items-center gap-0.5">
					<button
						type="button"
						// Don't stop propagation here so clicking the chevron also triggers the parent onClick (which does the toggle anyway)
						// But if we want it to be explicit, we can leave it. The parent handles it.
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
							<button type="button" onClick={(event) => event.stopPropagation()} className="flex cursor-pointer items-center gap-1.5">
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
									onSelect={() => setActiveTab(tab.id)}
								>
									{tab.label}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>

				{/* Right: optional header content (cursor position, etc.) */}
				{headerRight && <div className="flex min-w-0 items-center gap-2">{headerRight}</div>}
			</div>

			{/* Tab content */}
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
