import { useCallback, useState } from 'react';

interface DeferredOpen {
	dialogOpen: boolean;
	show: boolean;
	onExitComplete: () => void;
}

export function useDeferredOpen(open: boolean): DeferredOpen {
	const [previousOpen, setPreviousOpen] = useState(open);
	const [hasDeferredOpen, setHasDeferredOpen] = useState(open);

	if (open !== previousOpen) {
		setPreviousOpen(open);
		setHasDeferredOpen(true);
	}

	const onExitComplete = useCallback(() => {
		setHasDeferredOpen(false);
	}, []);

	return {
		dialogOpen: open || hasDeferredOpen,
		show: open,
		onExitComplete,
	};
}
