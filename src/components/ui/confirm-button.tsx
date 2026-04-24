import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useState } from 'react';

import { springSnappy, tweenFast } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import { Button } from './button';

import type { ButtonProps as ButtonProperties } from './button';
import type { ReactNode } from 'react';

interface ConfirmButtonProperties {
	children: ReactNode;
	title: string;
	description?: string;
	confirmLabel: string;
	cancelLabel?: string;
	loadingText?: string;
	onConfirm: () => Promise<void> | void;
	variant?: ButtonProperties['variant'];
	size?: ButtonProperties['size'];
	confirmVariant?: ButtonProperties['variant'];
	className?: string;
	disabled?: boolean;
}

const confirmPopoverVariants = {
	hidden: { opacity: 0, scale: 0.35, pointerEvents: 'none' },
	visible: { opacity: 1, scale: 1, y: 0, pointerEvents: 'auto' },
	exit: { opacity: 0, scale: 0.78, pointerEvents: 'none', transition: tweenFast },
};

const triggerLabelVariants = {
	visible: { opacity: 1, scale: 1 },
	hidden: { opacity: 0, scale: 0.9 },
};

export function ConfirmButton({
	children,
	title,
	description,
	confirmLabel,
	cancelLabel = 'Cancel',
	loadingText,
	onConfirm,
	variant = 'outline',
	size = 'sm',
	confirmVariant = 'danger',
	className,
	disabled = false,
}: ConfirmButtonProperties) {
	const [containerElement, setContainerElement] = useState<HTMLDivElement | undefined>();
	const [confirmButtonElement, setConfirmButtonElement] = useState<HTMLButtonElement | undefined>();
	const [open, setOpen] = useState(false);
	const [isConfirming, setIsConfirming] = useState(false);
	const titleId = useId();
	const descriptionId = useId();

	useEffect(() => {
		if (!open) return;

		confirmButtonElement?.focus();

		function handlePointerDown(event: PointerEvent) {
			if (!(event.target instanceof Node)) {
				return;
			}

			if (!containerElement?.contains(event.target)) {
				setOpen(false);
			}
		}

		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				setOpen(false);
			}
		}

		document.addEventListener('pointerdown', handlePointerDown);
		document.addEventListener('keydown', handleKeyDown);

		return () => {
			document.removeEventListener('pointerdown', handlePointerDown);
			document.removeEventListener('keydown', handleKeyDown);
		};
	}, [confirmButtonElement, containerElement, open]);

	async function handleConfirm() {
		setIsConfirming(true);
		try {
			await onConfirm();
			setOpen(false);
		} finally {
			setIsConfirming(false);
		}
	}

	return (
		<div ref={(element) => setContainerElement(element ?? undefined)} className="relative inline-flex items-center justify-center">
			<Button
				type="button"
				variant={variant}
				size={size}
				className={className}
				disabled={disabled}
				onClick={() => setOpen((currentValue) => !currentValue)}
			>
				<motion.span
					animate={open ? 'hidden' : 'visible'}
					variants={triggerLabelVariants}
					transition={tweenFast}
					className="inline-flex items-center gap-2"
				>
					{children}
				</motion.span>
			</Button>
			<AnimatePresence>
				{open && (
					<motion.div
						role="dialog"
						aria-modal="false"
						aria-labelledby={titleId}
						aria-describedby={description ? descriptionId : undefined}
						variants={confirmPopoverVariants}
						initial="hidden"
						animate="visible"
						exit="exit"
						transition={springSnappy}
						className={cn(
							`
								absolute top-1/2 left-1/2 z-20 flex min-w-40 -translate-1/2 flex-col
								items-center rounded-xl border border-border bg-bg-primary/95 p-2.5
								shadow-lg backdrop-blur-xl
							`,
							'origin-center',
						)}
					>
						<p id={titleId} className="text-center text-xs font-semibold text-text-primary">
							{title}
						</p>
						{description && (
							<p id={descriptionId} className="mt-1 text-center text-2xs/relaxed text-text-secondary">
								{description}
							</p>
						)}
						<div className="mt-2 flex items-center justify-center gap-1.5">
							<Button type="button" variant="secondary" size="sm" disabled={isConfirming} onClick={() => setOpen(false)}>
								{cancelLabel}
							</Button>
							<Button
								ref={(element) => setConfirmButtonElement(element ?? undefined)}
								type="button"
								variant={confirmVariant}
								size="sm"
								onClick={() => void handleConfirm()}
								isLoading={isConfirming}
								loadingText={loadingText}
							>
								{confirmLabel}
							</Button>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
