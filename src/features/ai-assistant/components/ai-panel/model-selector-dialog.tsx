import { Menu } from '@base-ui/react/menu';
import { motion } from 'motion/react';

import { Pill } from '@/components/ui/pill';
import { popoverVariants, springSnappy } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import { AI_MODELS, getModelLabel, type AIModelId } from './model-config';

interface ModelSelectorDropdownProperties {
	selectedModel: AIModelId;
	onSelectModel: (modelId: AIModelId) => void;
	disabled?: boolean;
}

export function ModelSelectorDropdown({ selectedModel, onSelectModel, disabled }: ModelSelectorDropdownProperties) {
	return (
		<Menu.Root>
			<Menu.Trigger
				disabled={disabled}
				render={
					<span
						className={cn(
							'max-w-full min-w-0 cursor-pointer overflow-hidden transition-colors',
							disabled && 'cursor-not-allowed opacity-40',
						)}
					/>
				}
			>
				<Pill size="md" color="muted">
					<span className="truncate">{getModelLabel(selectedModel)}</span>
				</Pill>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner side="top" align="start" sideOffset={4} collisionPadding={8}>
					<Menu.Popup
						render={<motion.div variants={popoverVariants} initial="hidden" animate="visible" exit="exit" transition={springSnappy} />}
						className="
							z-50 min-w-56 overflow-hidden rounded-md border border-border
							bg-bg-secondary shadow-md
						"
					>
						{AI_MODELS.map((model) => {
							const isSelected = model.id === selectedModel;
							return (
								<Menu.Item
									key={model.id}
									onClick={() => onSelectModel(model.id)}
									aria-current={isSelected ? 'true' : undefined}
									className={cn(
										`
											relative flex cursor-pointer items-center gap-3 px-3 py-2 text-left
											transition-colors outline-none select-none
											focus:bg-bg-tertiary
										`,
										isSelected && 'bg-accent/10',
									)}
								>
									<div className="flex-1">
										<div className={cn('text-sm font-medium', isSelected ? 'text-accent' : 'text-text-primary')}>{model.label}</div>
										{model.description && <div className="text-xs text-text-secondary">{model.description}</div>}
									</div>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
