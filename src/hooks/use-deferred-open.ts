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
