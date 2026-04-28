import { useEffect, useState } from 'react';

type DialogStackListener = () => void;

const dialogStackListeners = new Set<DialogStackListener>();
const openDialogIds = new Set<number>();

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
 * Registers an open dialog with the global stack while `open` is true.
 *
 * The shared backdrop is visible whenever at least one dialog is open,
 * so dialog-to-dialog or menu-to-dialog handoffs share the same single
 * DOM element and never flicker.
 */
export function useDialogStackPresence(open: boolean): void {
	const [dialogId] = useState(() => {
		const resolvedDialogId = nextDialogId;
		nextDialogId += 1;
		return resolvedDialogId;
	});

	useEffect(() => {
		if (!open) {
			return;
		}

		if (!openDialogIds.has(dialogId)) {
			openDialogIds.add(dialogId);
			openDialogCount = openDialogIds.size;
			emit();
		}

		return () => {
			if (openDialogIds.delete(dialogId)) {
				openDialogCount = openDialogIds.size;
				emit();
			}
		};
	}, [open, dialogId]);
}
