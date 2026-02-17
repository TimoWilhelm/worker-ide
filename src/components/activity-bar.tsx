/**
 * Activity Bar
 *
 * VS Code-style vertical icon strip on the far left of the IDE.
 * Switches between sidebar views: Explorer and Source Control (Git).
 */

import { Files, GitBranch } from 'lucide-react';

import { Tooltip } from '@/components/ui';
import { useStore, selectActiveSidebarView, selectGitChangedFileCount, type SidebarView } from '@/lib/store';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface ActivityBarProperties {
	className?: string;
}

interface ActivityBarItemProperties {
	icon: React.ReactNode;
	label: string;
	view: SidebarView;
	activeView: SidebarView;
	badge?: number;
	onSelect: (view: SidebarView) => void;
}

// =============================================================================
// ActivityBarItem
// =============================================================================

function ActivityBarItem({ icon, label, view, activeView, badge, onSelect }: ActivityBarItemProperties) {
	const isActive = activeView === view;

	return (
		<Tooltip content={label} side="right" delayDuration={300}>
			<button
				type="button"
				onClick={() => onSelect(view)}
				className={cn(
					'relative flex size-10 cursor-pointer items-center justify-center',
					'transition-colors',
					isActive
						? 'border-l-2 border-accent text-text-primary'
						: `
							border-l-2 border-transparent text-text-secondary
							hover:text-text-primary
						`,
				)}
			>
				{icon}
				{badge !== undefined && badge > 0 && (
					<span
						className={cn(
							'absolute top-1 right-1 flex size-4 items-center justify-center',
							'rounded-full bg-accent text-[10px] leading-none font-bold text-white',
						)}
					>
						{badge > 99 ? '99+' : badge}
					</span>
				)}
			</button>
		</Tooltip>
	);
}

// =============================================================================
// ActivityBar
// =============================================================================

export function ActivityBar({ className }: ActivityBarProperties) {
	const activeSidebarView = useStore(selectActiveSidebarView);
	const setActiveSidebarView = useStore((state) => state.setActiveSidebarView);
	const gitChangedCount = useStore(selectGitChangedFileCount);

	return (
		<div
			className={cn(
				`
					flex w-10 shrink-0 flex-col items-center border-r border-border
					bg-bg-primary pt-1
				`,
				className,
			)}
		>
			<ActivityBarItem
				icon={<Files className="size-5" />}
				label="Explorer"
				view="explorer"
				activeView={activeSidebarView}
				onSelect={setActiveSidebarView}
			/>
			<ActivityBarItem
				icon={<GitBranch className="size-5" />}
				label="Source Control"
				view="git"
				activeView={activeSidebarView}
				badge={gitChangedCount}
				onSelect={setActiveSidebarView}
			/>
		</div>
	);
}
