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

import { ChevronDown } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';

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

export function UtilityPanel({ projectId, onToggle, logCounts, headerRight, className }: UtilityPanelProperties) {
	const [activeTab, setActiveTab] = useState<UtilityTab>('output');

	return (
		<div className={cn('flex h-full flex-col overflow-hidden', className)}>
			{/* Combined header: clicking the bar collapses the panel */}
			<div
				onClick={onToggle}
				className="
					flex h-8 shrink-0 cursor-pointer items-center justify-between border-b
					border-border bg-bg-secondary px-2 transition-colors
					hover:bg-bg-tertiary
				"
			>
				{/* Left: chevron + tabs */}
				<div className="flex items-center gap-0.5">
					<button
						type="button"
						// Don't stop propagation here so clicking the chevron also triggers the parent onClick (which does the toggle anyway)
						// But if we want it to be explicit, we can leave it. The parent handles it.
						className="
							mr-1 flex cursor-pointer items-center justify-center rounded-sm p-0.5
							text-text-secondary transition-colors
							hover:text-text-primary
						"
						aria-label="Hide utility panel"
					>
						<ChevronDown className="size-3" />
					</button>

					<div role="tablist" aria-label="Utility panels" className="flex items-center gap-0.5">
						{TABS.map((tab) => (
							<button
								key={tab.id}
								type="button"
								role="tab"
								aria-selected={activeTab === tab.id}
								aria-controls={`utility-tabpanel-${tab.id}`}
								onClick={(event) => {
									event.stopPropagation();
									setActiveTab(tab.id);
								}}
								className={cn(
									`
										flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-px
										text-xs transition-colors
									`,
									activeTab === tab.id ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary',
								)}
							>
								{tab.label}
								{/* Inline badges next to tab label */}
								{tab.id === 'output' && logCounts && (
									<>
										{logCounts.errors > 0 && <Pill color="red">{logCounts.errors}</Pill>}
										{logCounts.warnings > 0 && <Pill color="yellow">{logCounts.warnings}</Pill>}
									</>
								)}
							</button>
						))}
					</div>
				</div>

				{/* Right: optional header content (cursor position, etc.) */}
				{headerRight && <div className="flex items-center gap-2">{headerRight}</div>}
			</div>

			{/* Tab content */}
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
		</div>
	);
}
