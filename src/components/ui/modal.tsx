/**
 * Modal Dialog Component
 *
 * Reusable modal dialog using radix-ui Dialog primitives.
 * Used for new file creation and other form dialogs.
 */

import { Dialog } from 'radix-ui';

import { cn } from '@/lib/utils';

import type { ReactNode, Ref } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface ModalProperties {
	/** Whether the dialog is open */
	open: boolean;
	/** Callback when open state changes */
	onOpenChange: (open: boolean) => void;
	/** Dialog title */
	title: string;
	/** Dialog content */
	children: ReactNode;
	/** CSS class name for the content */
	className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function Modal({ open, onOpenChange, title, children, className }: ModalProperties) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/60" />
				<Dialog.Content
					className={cn(
						`fixed top-1/2 left-1/2 z-50 w-[400px] max-w-[90vw] animate-fade-in`,
						`-translate-x-1/2 -translate-y-1/2 rounded-lg border border-border`,
						`bg-bg-secondary shadow-lg`,
						className,
					)}
				>
					<div
						className="
							flex items-center justify-between border-b border-border px-4 py-3
						"
					>
						<Dialog.Title className="text-sm font-semibold text-text-primary">{title}</Dialog.Title>
						<Dialog.Close
							className={cn(
								`flex size-6 items-center justify-center rounded-sm text-text-secondary`,
								`
									transition-colors
									hover:bg-bg-tertiary hover:text-text-primary
								`,
							)}
						>
							<span className="text-lg leading-none">&times;</span>
						</Dialog.Close>
					</div>
					{children}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

// =============================================================================
// Sub-components
// =============================================================================

export function ModalBody({ children, className, ref }: { children: ReactNode; className?: string; ref?: Ref<HTMLDivElement> }) {
	return (
		<div ref={ref} className={cn('px-4 py-4', className)}>
			{children}
		</div>
	);
}

export function ModalFooter({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn('flex justify-end gap-2 border-t border-border px-4 py-3', className)}>{children}</div>;
}
