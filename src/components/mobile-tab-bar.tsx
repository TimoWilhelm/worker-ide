/**
 * Mobile Tab Bar Component
 *
 * Fixed bottom navigation bar for switching between Editor, Preview, and Agent views on mobile.
 */

import { Bot, Code, Eye, GitBranch } from 'lucide-react';

import { BorderBeam } from '@/components/ui/border-beam';
import { selectIsProcessing, useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import type { MobilePanel } from '@/lib/store';

// =============================================================================
// Component
// =============================================================================

const TABS: Array<{ panel: MobilePanel; label: string; icon: typeof Code }> = [
	{ panel: 'editor', label: 'Editor', icon: Code },
	{ panel: 'preview', label: 'Preview', icon: Eye },
	{ panel: 'git', label: 'Git', icon: GitBranch },
	{ panel: 'agent', label: 'Agent', icon: Bot },
];

export function MobileTabBar() {
	const activeMobilePanel = useStore((state) => state.activeMobilePanel);
	const setActiveMobilePanel = useStore((state) => state.setActiveMobilePanel);
	const isProcessing = useStore(selectIsProcessing);

	return (
		<nav
			className="
				flex h-12 shrink-0 items-stretch border-t border-border bg-bg-secondary
				pb-[env(safe-area-inset-bottom)]
			"
		>
			{/* Panel tabs */}
			{TABS.map(({ panel, label, icon: Icon }) => {
				const isActive = activeMobilePanel === panel;
				const showProcessingIndicator = panel === 'agent' && isProcessing && !isActive;

				return (
					<button
						key={panel}
						type="button"
						onClick={() => setActiveMobilePanel(panel)}
						className={cn(
							`
								relative flex flex-1 cursor-pointer flex-col items-center justify-center
								gap-0.5 transition-colors
							`,
							isActive ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
						)}
						aria-label={label}
						aria-current={isActive ? 'page' : undefined}
					>
						<Icon className="size-5" />
						<span className="text-3xs font-medium">{label}</span>
						{showProcessingIndicator && <BorderBeam duration={1.5} />}
					</button>
				);
			})}
		</nav>
	);
}
