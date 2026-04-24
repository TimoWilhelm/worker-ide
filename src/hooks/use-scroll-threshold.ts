import { useEffect, useState } from 'react';

interface UseScrollThresholdOptions {
	element?: HTMLElement;
	threshold?: number;
	disabled?: boolean;
}

export function useScrollThreshold({ element, threshold = 8, disabled = false }: UseScrollThresholdOptions): boolean {
	const [hasCrossedThreshold, setHasCrossedThreshold] = useState(false);

	useEffect(() => {
		if (disabled) return;

		const scrollTarget = element ?? globalThis;
		let frame = 0;

		const readScrollOffset = () => {
			frame = 0;
			const nextValue = scrollTarget instanceof HTMLElement ? scrollTarget.scrollTop > threshold : globalThis.scrollY > threshold;
			setHasCrossedThreshold((currentValue) => (currentValue === nextValue ? currentValue : nextValue));
		};

		const handleScroll = () => {
			if (frame !== 0) return;
			frame = globalThis.requestAnimationFrame(readScrollOffset);
		};

		readScrollOffset();
		scrollTarget.addEventListener('scroll', handleScroll, { passive: true });

		return () => {
			if (frame !== 0) {
				globalThis.cancelAnimationFrame(frame);
			}
			scrollTarget.removeEventListener('scroll', handleScroll);
		};
	}, [disabled, element, threshold]);

	return disabled ? false : hasCrossedThreshold;
}
