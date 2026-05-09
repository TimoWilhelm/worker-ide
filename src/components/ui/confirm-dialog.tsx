import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Check, Copy } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

import { useDeferredOpen } from '@/hooks/use-deferred-open';
import { modalContentVariants, springDefault } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import { Button } from './button';
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
	resourceName?: string;
	isConfirming?: boolean;
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
	resourceName,
	isConfirming = false,
}: ConfirmDialogProperties) {
	const { dialogOpen, show, onExitComplete } = useDeferredOpen(open);
	useDialogStackPresence(open);

	const [typedConfirmation, setTypedConfirmation] = useState('');
	const [copied, setCopied] = useState(false);

	const confirmationMatches = resourceName ? typedConfirmation === resourceName : true;

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) {
			setTypedConfirmation('');
			setCopied(false);
		}
		onOpenChange(nextOpen);
	}

	function handleCopyResourceName() {
		if (!resourceName) return;
		void navigator.clipboard.writeText(resourceName).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	}

	const cancelButtonClassName = cn(
		`
			inline-flex cursor-pointer items-center justify-center rounded-md border
			border-border
		`,
		`bg-bg-tertiary px-3 py-1.5 text-sm font-medium text-text-primary`,
		`
			transition-colors
			hover:bg-border
		`,
	);

	const confirmButtonClassName = cn(
		`
			inline-flex cursor-pointer items-center justify-center rounded-md px-3 py-1.5
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
		(resourceName && !confirmationMatches) || isConfirming ? 'cursor-not-allowed opacity-50' : '',
	);

	return (
		<AlertDialog.Root open={dialogOpen} onOpenChange={handleOpenChange}>
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
									<AlertDialog.Description render={<div />} className="text-sm/relaxed text-text-secondary">
										{description}
									</AlertDialog.Description>

									{resourceName && (
										<div className="mt-4 space-y-3">
											<p className="text-sm text-text-secondary">
												Type in{' '}
												<button
													type="button"
													onClick={handleCopyResourceName}
													className={cn(
														`
															inline-flex cursor-pointer items-center gap-1.5 rounded-md border
															border-border
														`,
														`bg-bg-tertiary px-1.5 py-0.5 text-xs font-semibold`,
														`wrap-break-word text-text-primary`,
														`
															transition-colors
															hover:bg-border/50
														`,
													)}
												>
													{resourceName}
													{copied ? (
														<Check className="size-3 align-middle text-success" />
													) : (
														<Copy className="size-3 align-middle text-text-secondary" />
													)}
												</button>{' '}
												to confirm
											</p>
											<input
												type="text"
												value={typedConfirmation}
												onChange={(event) => setTypedConfirmation(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === 'Enter' && confirmationMatches && !isConfirming) {
														onConfirm();
													}
												}}
												disabled={isConfirming}
												placeholder={resourceName}
												autoComplete="off"
												className={cn(
													`h-9 w-full rounded-md border border-border bg-bg-secondary/60`,
													`px-3 text-sm text-text-primary transition-colors`,
													`placeholder:text-text-secondary/40`,
													`
														focus-within:border-accent
														focus:outline-none
													`,
												)}
											/>
										</div>
									)}
								</div>
								<div className="flex justify-end gap-2 border-t border-border px-4 py-3">
									{resourceName ? (
										<>
											<Button type="button" variant="secondary" onClick={() => handleOpenChange(false)} disabled={isConfirming}>
												{cancelLabel}
											</Button>
											<Button
												type="button"
												onClick={onConfirm}
												disabled={!confirmationMatches}
												variant={variant === 'danger' ? 'danger' : variant === 'warning' ? 'warning' : 'default'}
												isLoading={isConfirming}
											>
												{confirmLabel}
											</Button>
										</>
									) : (
										<>
											<AlertDialog.Close className={cancelButtonClassName}>{cancelLabel}</AlertDialog.Close>
											<AlertDialog.Close onClick={onConfirm} className={confirmButtonClassName}>
												{confirmLabel}
											</AlertDialog.Close>
										</>
									)}
								</div>
							</AlertDialog.Popup>
						)}
					</AnimatePresence>
				</AlertDialog.Portal>
			)}
		</AlertDialog.Root>
	);
}
