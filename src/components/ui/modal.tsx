import { Dialog } from '@base-ui/react/dialog';
import { AnimatePresence, motion } from 'motion/react';

import { useDeferredOpen } from '@/hooks/use-deferred-open';
import { modalContentVariants, springDefault } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import { useDialogStackPresence } from './dialog-stack';

import type { ReactNode, Ref } from 'react';

export interface ModalProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	children: ReactNode;
	className?: string;
	hideClose?: boolean;
}

export function Modal({ open, onOpenChange, title, children, className, hideClose }: ModalProperties) {
	const { dialogOpen, show, onExitComplete } = useDeferredOpen(open);
	useDialogStackPresence(dialogOpen);

	return (
		<Dialog.Root open={dialogOpen} onOpenChange={onOpenChange}>
			{dialogOpen && (
				<Dialog.Portal keepMounted>
					<AnimatePresence onExitComplete={onExitComplete}>
						{show && (
							<Dialog.Popup
								render={
									<motion.div variants={modalContentVariants} initial="hidden" animate="visible" exit="exit" transition={springDefault} />
								}
								className={cn(
									`fixed top-1/2 left-1/2 z-50 w-[400px] max-w-[90vw]`,
									`-translate-1/2 rounded-lg border border-border`,
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
									{!hideClose && (
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
									)}
								</div>
								{children}
							</Dialog.Popup>
						)}
					</AnimatePresence>
				</Dialog.Portal>
			)}
		</Dialog.Root>
	);
}

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
