import { motion } from 'motion/react';
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { getDialogStackSnapshot, subscribeDialogStack } from './dialog-stack';

/**
 * Single global backdrop element. Mount once at the app root.
 *
 * The element is always mounted and only animates its opacity based on
 * whether any dialog is open. This eliminates any possibility of flicker
 * during handoff between sibling modals.
 */
export function GlobalDialogBackdrop() {
	const count = useSyncExternalStore(subscribeDialogStack, getDialogStackSnapshot, getDialogStackSnapshot);
	const visible = count > 0;

	if (typeof document === 'undefined') {
		return <></>;
	}

	return createPortal(
		<motion.div
			data-testid="modal-backdrop"
			aria-hidden="true"
			initial={false}
			animate={{ opacity: visible ? 1 : 0 }}
			transition={{ duration: 0.15, ease: 'easeOut' }}
			style={{ pointerEvents: visible ? 'auto' : 'none' }}
			className="fixed inset-0 z-40 bg-black/60"
		/>,
		document.body,
	);
}
