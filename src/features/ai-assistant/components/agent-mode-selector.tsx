/**
 * Agent Mode Selector
 *
 * Dropdown button for switching between AI agent modes (code, plan, ask).
 * Each mode has a distinct color and icon for quick visual identification.
 */

import { Code, Map as MapIcon, MessageCircleQuestion } from 'lucide-react';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Pill, type PillProperties } from '@/components/ui/pill';
import { cn } from '@/lib/utils';

import type { AgentMode } from '@shared/types';

// =============================================================================
// Mode Configuration
// =============================================================================

interface ModeConfig {
	label: string;
	description: string;
	icon: typeof Code;
	colorClass: string;
	pillColor: NonNullable<PillProperties['color']>;
}

const MODE_CONFIG: Record<AgentMode, ModeConfig> = {
	code: {
		label: 'Code',
		description: 'Full tool access — edit files, run searches',
		icon: Code,
		colorClass: 'text-emerald-600 dark:text-emerald-400',
		pillColor: 'emerald',
	},
	plan: {
		label: 'Plan',
		description: 'Read-only research — produces an implementation plan',
		icon: MapIcon,
		colorClass: 'text-amber-600 dark:text-amber-400',
		pillColor: 'amber',
	},
	ask: {
		label: 'Ask',
		description: 'No tools — conversational Q&A only',
		icon: MessageCircleQuestion,
		colorClass: 'text-sky-600 dark:text-sky-400',
		pillColor: 'sky',
	},
};

const MODES: AgentMode[] = ['code', 'plan', 'ask'];

// =============================================================================
// Component
// =============================================================================

interface AgentModeSelectorProperties {
	mode: AgentMode;
	onModeChange: (mode: AgentMode) => void;
	disabled?: boolean;
}

export function AgentModeSelector({ mode, onModeChange, disabled }: AgentModeSelectorProperties) {
	const config = MODE_CONFIG[mode];
	const Icon = config.icon;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={disabled}>
				<Pill
					size="md"
					color={config.pillColor}
					className={cn('cursor-pointer transition-colors', disabled && 'cursor-not-allowed opacity-40')}
				>
					<Icon className="size-3" />
					{config.label}
				</Pill>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				{MODES.map((modeOption) => {
					const optionConfig = MODE_CONFIG[modeOption];
					const OptionIcon = optionConfig.icon;
					const isActive = modeOption === mode;
					return (
						<DropdownMenuItem key={modeOption} onSelect={() => onModeChange(modeOption)}>
							<div className="flex w-full items-center gap-2.5">
								<OptionIcon className={cn('size-4 shrink-0', isActive ? optionConfig.colorClass : 'text-text-secondary')} />
								<div className="flex flex-col">
									<span className={cn('text-sm font-medium', isActive && optionConfig.colorClass)}>{optionConfig.label}</span>
									<span className="text-2xs text-text-secondary">{optionConfig.description}</span>
								</div>
							</div>
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
