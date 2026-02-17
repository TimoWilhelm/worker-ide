/**
 * Model Selector Dialog
 *
 * Dialog for selecting the AI model to use in the AI assistant.
 * Displays available models with their labels and allows the user to select one.
 */

import { Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { cn } from '@/lib/utils';

import { AI_MODELS, type AIModelId } from './model-config';

// =============================================================================
// Component
// =============================================================================

interface ModelSelectorDialogProperties {
	/** Whether the dialog is open */
	open: boolean;
	/** Callback when open state changes */
	onOpenChange: (open: boolean) => void;
	/** Currently selected model ID */
	selectedModel: AIModelId;
	/** Callback when a model is selected */
	onSelectModel: (modelId: AIModelId) => void;
}

export function ModelSelectorDialog({ open, onOpenChange, selectedModel, onSelectModel }: ModelSelectorDialogProperties) {
	const handleSelectModel = (modelId: AIModelId) => {
		onSelectModel(modelId);
		onOpenChange(false);
	};

	return (
		<Modal open={open} onOpenChange={onOpenChange} title="Select Model">
			<ModalBody className="space-y-1 p-2">
				{AI_MODELS.map((model) => {
					const isSelected = model.id === selectedModel;
					return (
						<button
							key={model.id}
							onClick={() => handleSelectModel(model.id)}
							className={cn(
								`
									flex w-full items-center gap-3 rounded-md px-3 py-2 text-left
									transition-colors
								`,
								isSelected ? 'bg-accent/10 text-accent' : 'hover:bg-bg-tertiary',
							)}
						>
							<div className="flex-1">
								<div className={cn('text-sm font-medium', isSelected ? 'text-accent' : 'text-text-primary')}>{model.label}</div>
								{model.description && <div className="text-xs text-text-secondary">{model.description}</div>}
							</div>
							{isSelected && <Check className="size-4 shrink-0 text-accent" />}
						</button>
					);
				})}
			</ModalBody>
			<ModalFooter>
				<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
			</ModalFooter>
		</Modal>
	);
}
