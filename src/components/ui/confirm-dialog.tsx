/**
 * Confirm Dialog Component
 *
 * Reusable confirmation dialog using radix-ui AlertDialog primitives.
 * Replaces browser-native confirm() calls with a styled modal.
 */

import { AlertDialog } from 'radix-ui';

import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface ConfirmDialogProperties {
	/** Whether the dialog is open */
	open: boolean;
	/** Callback when open state changes */
	onOpenChange: (open: boolean) => void;
	/** Dialog title */
	title: string;
	/** Dialog description / message */
	description: ReactNode;
	/** Confirm button label (default: "Confirm") */
	confirmLabel?: string;
	/** Cancel button label (default: "Cancel") */
	cancelLabel?: string;
	/** Callback when confirmed */
	onConfirm: () => void;
	/** Visual variant (default: "default") */
	variant?: 'default' | 'danger';
}

// =============================================================================
// Component
// =============================================================================

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel = 'Confirm',
	cancelLabel = 'Cancel',
	onConfirm,
	variant = 'default',
}: ConfirmDialogProperties) {
	return (
		<AlertDialog.Root open={open} onOpenChange={onOpenChange}>
			<AlertDialog.Portal>
				<AlertDialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/60" />
				<AlertDialog.Content
					className={cn(
						`fixed top-1/2 left-1/2 z-50 w-[400px] max-w-[90vw] animate-fade-in`,
						`-translate-1/2 rounded-lg border border-border`,
						`bg-bg-secondary shadow-lg`,
					)}
				>
					<div className="border-b border-border px-4 py-3">
						<AlertDialog.Title className="text-sm font-semibold text-text-primary">{title}</AlertDialog.Title>
					</div>
					<div className="p-4">
						<AlertDialog.Description className="text-sm/relaxed text-text-secondary">{description}</AlertDialog.Description>
					</div>
					<div className="flex justify-end gap-2 border-t border-border px-4 py-3">
						<AlertDialog.Cancel
							className={cn(
								`
									inline-flex items-center justify-center rounded-md border border-border
								`,
								`bg-bg-tertiary px-3 py-1.5 text-sm font-medium text-text-primary`,
								`
									transition-colors
									hover:bg-border
								`,
							)}
						>
							{cancelLabel}
						</AlertDialog.Cancel>
						<AlertDialog.Action
							onClick={onConfirm}
							className={cn(
								`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm`,
								`font-medium text-white transition-colors`,
								variant === 'danger'
									? `
										bg-error
										hover:bg-red-600
									`
									: `
										bg-accent
										hover:bg-accent-hover
									`,
							)}
						>
							{confirmLabel}
						</AlertDialog.Action>
					</div>
				</AlertDialog.Content>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}
