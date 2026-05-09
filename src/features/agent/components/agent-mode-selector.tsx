import { Code, Map as MapIcon, MessageCircleQuestion } from 'lucide-react';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Pill, type PillProperties } from '@/components/ui/pill';
import { cn } from '@/lib/utils';

import type { AgentMode } from '@shared/types';

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
		description: 'Build and edit files',
		icon: Code,
		colorClass: 'text-emerald-600 dark:text-emerald-400',
		pillColor: 'emerald',
	},
	plan: {
		label: 'Plan',
		description: 'Research and design',
		icon: MapIcon,
		colorClass: 'text-amber-600 dark:text-amber-400',
		pillColor: 'amber',
	},
	ask: {
		label: 'Ask',
		description: 'Get answers',
		icon: MessageCircleQuestion,
		colorClass: 'text-sky-600 dark:text-sky-400',
		pillColor: 'sky',
	},
};

const MODES: AgentMode[] = ['code', 'plan', 'ask'];

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
			<DropdownMenuTrigger disabled={disabled}>
				<button type="button" className={cn('max-w-full min-w-0 rounded-full', disabled && 'cursor-not-allowed opacity-40')}>
					<Pill
						size="md"
						color={config.pillColor}
						className="
							max-w-full min-w-0 cursor-pointer overflow-hidden transition-colors
						"
					>
						<Icon className="size-3 shrink-0" />
						<span
							className="
								hidden truncate
								@xs:inline
							"
						>
							{config.label}
						</span>
					</Pill>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				{MODES.map((modeOption) => {
					const optionConfig = MODE_CONFIG[modeOption];
					const OptionIcon = optionConfig.icon;
					const isActive = modeOption === mode;
					return (
						<DropdownMenuItem key={modeOption} onSelect={() => onModeChange(modeOption)} aria-current={isActive ? 'true' : undefined}>
							<div className="flex w-full items-center gap-2.5">
								<OptionIcon className={cn('size-4 shrink-0', isActive ? optionConfig.colorClass : 'text-text-secondary')} />
								<div className="flex flex-col">
									<span className={cn('text-sm font-medium', isActive && optionConfig.colorClass)}>{optionConfig.label}</span>
									<span className="text-xs text-text-secondary">{optionConfig.description}</span>
								</div>
							</div>
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
