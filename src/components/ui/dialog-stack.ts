import { useEffect, useRef, useState } from 'react';

type DialogStackListener = () => void;

const dialogStackListeners = new Set<DialogStackListener>();
const openDialogIds = new Set<number>();
const dialogCloseCallbacks = new Map<number, () => void>();

let nextDialogId = 0;
let openDialogCount = 0;

function emit(): void {
	for (const listener of dialogStackListeners) {
		listener();
	}
}

export function subscribeDialogStack(listener: DialogStackListener): () => void {
	dialogStackListeners.add(listener);
	return () => {
		dialogStackListeners.delete(listener);
	};
}

export function getDialogStackSnapshot(): number {
	return openDialogCount;
}

/**
 * Closes the most recently opened dialog that has a registered close callback.
 * Called by the global backdrop on click.
 */
export function closeTopDialog(): void {
	if (openDialogIds.size === 0) return;
	const topId = Math.max(...openDialogIds);
	dialogCloseCallbacks.get(topId)?.();
}

/**
 * Registers an open dialog with the global stack while `open` is true.
 *
 * The shared backdrop is visible whenever at least one dialog is open,
 * so dialog-to-dialog or menu-to-dialog handoffs share the same single
 * DOM element and never flicker.
 *
 * Pass `onClose` to make the dialog dismissible via a backdrop click.
 * Omit it (e.g. for AlertDialog / ConfirmDialog) to keep it non-dismissible.
 */
export function useDialogStackPresence(open: boolean, onClose?: () => void): void {
	const [dialogId] = useState(() => {
		const resolvedDialogId = nextDialogId;
		nextDialogId += 1;
		return resolvedDialogId;
	});

	// Keep the callback ref current without re-running the effect on every render.
	const onCloseReference = useRef(onClose);
	useEffect(() => {
		onCloseReference.current = onClose;
	});

	useEffect(() => {
		if (!open) {
			return;
		}

		openDialogIds.add(dialogId);
		// Register a stable wrapper that always invokes the latest callback.
		dialogCloseCallbacks.set(dialogId, () => onCloseReference.current?.());
		openDialogCount = openDialogIds.size;
		emit();

		return () => {
			if (openDialogIds.delete(dialogId)) {
				dialogCloseCallbacks.delete(dialogId);
				openDialogCount = openDialogIds.size;
				emit();
			}
		};
	}, [open, dialogId]);
}
