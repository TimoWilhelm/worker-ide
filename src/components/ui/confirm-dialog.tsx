import { AlertDialog } from '@base-ui/react/alert-dialog';
import { AnimatePresence, motion } from 'motion/react';

import { useDeferredOpen } from '@/hooks/use-deferred-open';
import { modalContentVariants, springDefault } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import { useDialogStackPresence } from './dialog-stack';

import type { ReactNode } from 'react';

export interface ConfirmDialogProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	onConfirm: () => void;
	variant?: 'default' | 'danger' | 'warning';
}

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
	const { dialogOpen, show, onExitComplete } = useDeferredOpen(open);
	useDialogStackPresence(dialogOpen);

	return (
		<AlertDialog.Root open={dialogOpen} onOpenChange={onOpenChange}>
			{dialogOpen && (
				<AlertDialog.Portal keepMounted>
					<AnimatePresence onExitComplete={onExitComplete}>
						{show && (
							<AlertDialog.Popup
								render={
									<motion.div variants={modalContentVariants} initial="hidden" animate="visible" exit="exit" transition={springDefault} />
								}
								className={cn(
									`fixed top-1/2 left-1/2 z-50 w-[400px] max-w-[90vw]`,
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
									<AlertDialog.Close
										className={cn(
											`
												inline-flex items-center justify-center rounded-md border
												border-border
											`,
											`bg-bg-tertiary px-3 py-1.5 text-sm font-medium text-text-primary`,
											`
												transition-colors
												hover:bg-border
											`,
										)}
									>
										{cancelLabel}
									</AlertDialog.Close>
									<AlertDialog.Close
										onClick={onConfirm}
										className={cn(
											`
												inline-flex items-center justify-center rounded-md px-3 py-1.5
												text-sm
											`,
											`font-medium text-white transition-colors`,
											variant === 'danger'
												? `
													bg-red-600
													hover:bg-red-700
												`
												: variant === 'warning'
													? `
														bg-warning text-black
														hover:bg-yellow-600
													`
													: `
														bg-accent
														hover:bg-accent-hover
													`,
										)}
									>
										{confirmLabel}
									</AlertDialog.Close>
								</div>
							</AlertDialog.Popup>
						)}
					</AnimatePresence>
				</AlertDialog.Portal>
			)}
		</AlertDialog.Root>
	);
}
