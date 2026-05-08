import { Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

interface InlineConfirmGroupProperties {
	/** Name of the item being deleted, used for aria-labels */
	itemName: string;
	/** Called when the user confirms the delete (second trash click) */
	onConfirm: () => void;
	/** Called when the user cancels (X, Escape, or click-outside) */
	onCancel: () => void;
	/** Extra class names on the wrapper */
	className?: string;
}

/**
 * Inline two-click delete confirmation: red trash (confirm) + X (cancel).
 *
 * Provides full keyboard and screen-reader support:
 * - Auto-focuses the confirm button on mount
 * - Traps Tab/Shift-Tab between the two buttons
 * - Escape dismisses (with stopPropagation so parent menus stay open)
 * - Click-outside dismisses
 * - `role="group"` with descriptive `aria-label`
 */
export function InlineConfirmGroup({ itemName, onConfirm, onCancel, className }: InlineConfirmGroupProperties) {
	const containerReference = useRef<HTMLDivElement>(null);
	const confirmButtonReference = useRef<HTMLButtonElement>(null);
	const cancelButtonReference = useRef<HTMLButtonElement>(null);

	// Auto-focus confirm button + click-outside dismiss
	useEffect(() => {
		confirmButtonReference.current?.focus();

		function handlePointerDown(event: PointerEvent) {
			if (!(event.target instanceof Node)) return;
			if (!containerReference.current?.contains(event.target)) {
				onCancel();
			}
		}

		document.addEventListener('pointerdown', handlePointerDown);
		return () => {
			document.removeEventListener('pointerdown', handlePointerDown);
		};
	}, [onCancel]);

	// Full focus trap: block all navigation keys from escaping
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			switch (event.key) {
				case 'Escape': {
					event.preventDefault();
					event.stopPropagation();
					onCancel();
					return;
				}
				case 'Tab':
				case 'ArrowLeft':
				case 'ArrowRight': {
					event.preventDefault();
					event.stopPropagation();
					// Toggle focus between confirm and cancel
					if (document.activeElement === confirmButtonReference.current) {
						cancelButtonReference.current?.focus();
					} else {
						confirmButtonReference.current?.focus();
					}
					return;
				}
				case 'ArrowUp':
				case 'ArrowDown': {
					// Block arrow keys from escaping to parent navigation
					event.preventDefault();
					event.stopPropagation();
					return;
				}
				case 'Enter':
				case ' ': {
					// Let the browser activate the focused button but prevent parent handlers
					event.stopPropagation();
					return;
				}
				default: {
					return;
				}
			}
		},
		[onCancel],
	);

	const handleConfirmClick = useCallback(
		(event: React.MouseEvent) => {
			event.stopPropagation();
			onConfirm();
		},
		[onConfirm],
	);

	const handleCancelClick = useCallback(
		(event: React.MouseEvent) => {
			event.stopPropagation();
			onCancel();
		},
		[onCancel],
	);

	return (
		<div
			ref={containerReference}
			role="group"
			aria-label={`Delete confirmation for ${itemName}`}
			className={cn('flex shrink-0 items-center gap-0.5', className)}
			onClick={(event) => event.stopPropagation()}
			onKeyDown={handleKeyDown}
		>
			<button
				ref={confirmButtonReference}
				type="button"
				tabIndex={0}
				onClick={handleConfirmClick}
				className="
					flex size-4 cursor-pointer items-center justify-center rounded-sm
					text-error transition-colors
					hover:bg-error/10
				"
				aria-label={`Confirm delete ${itemName}`}
			>
				<Trash2 className="size-3" />
			</button>
			<button
				ref={cancelButtonReference}
				type="button"
				tabIndex={0}
				onClick={handleCancelClick}
				className="
					flex size-4 cursor-pointer items-center justify-center rounded-sm
					text-text-secondary transition-colors
					hover:bg-bg-tertiary hover:text-text-primary
				"
				aria-label={`Cancel delete ${itemName}`}
			>
				<X className="size-3" />
			</button>
		</div>
	);
}
