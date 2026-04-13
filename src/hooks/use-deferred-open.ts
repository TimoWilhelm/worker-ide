/**
 * Deferred Open Hook
 *
 * Base UI Dialog/AlertDialog immediately hides the popup when `open` becomes
 * false, which kills AnimatePresence exit animations. This hook keeps the
 * dialog's `open` prop true until AnimatePresence fires `onExitComplete`,
 * giving the exit animation time to play.
 */

import { useCallback, useState } from 'react';

interface DeferredOpen {
	dialogOpen: boolean;
	show: boolean;
	onExitComplete: () => void;
}

export function useDeferredOpen(open: boolean): DeferredOpen {
	const [previousOpen, setPreviousOpen] = useState(open);
	const [animating, setAnimating] = useState(false);

	// Adjust state during render when the prop changes (React 19 pattern).
	if (open !== previousOpen) {
		setPreviousOpen(open);
		if (open) {
			setAnimating(true);
		}
	}

	const onExitComplete = useCallback(() => {
		setAnimating(false);
	}, []);

	return {
		dialogOpen: open || animating,
		show: open,
		onExitComplete,
	};
}
