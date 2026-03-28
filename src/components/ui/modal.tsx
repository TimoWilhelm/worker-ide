/**
 * Modal Dialog Component
 *
 * Reusable modal dialog using radix-ui Dialog primitives.
 * Used for new file creation and other form dialogs.
 */

import { AnimatePresence, motion } from 'motion/react';
import { Dialog } from 'radix-ui';

import { modalContentVariants, overlayVariants, springDefault, tweenFast } from '@/lib/motion-config';
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
			<AnimatePresence>
				{open && (
					<Dialog.Portal forceMount>
						<Dialog.Overlay asChild>
							<motion.div
								className="fixed inset-0 z-50 bg-black/60"
								variants={overlayVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
								transition={tweenFast}
							/>
						</Dialog.Overlay>
						<Dialog.Content asChild>
							<motion.div
								className={cn(
									`fixed top-1/2 left-1/2 z-50 w-[400px] max-w-[90vw]`,
									`-translate-1/2 rounded-lg border border-border`,
									`bg-bg-secondary shadow-lg`,
									className,
								)}
								variants={modalContentVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
								transition={springDefault}
							>
								<div
									className="
										flex items-center justify-between border-b border-border px-4 py-3
									"
								>
									<Dialog.Title className="text-sm font-semibold text-text-primary">{title}</Dialog.Title>
									<Dialog.Close
										className={cn(
											`
												flex size-6 items-center justify-center rounded-sm
												text-text-secondary
											`,
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
							</motion.div>
						</Dialog.Content>
					</Dialog.Portal>
				)}
			</AnimatePresence>
		</Dialog.Root>
	);
}

// =============================================================================
// Sub-components
// =============================================================================

export function ModalBody({ children, className, ref }: { children: ReactNode; className?: string; ref?: Ref<HTMLDivElement> }) {
	return (
		<div ref={ref} className={cn('p-4', className)}>
			{children}
		</div>
	);
}

export function ModalFooter({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn('flex justify-end gap-2 border-t border-border px-4 py-3', className)}>{children}</div>;
}
