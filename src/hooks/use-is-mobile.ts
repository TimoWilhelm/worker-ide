/**
 * Mobile Detection Hook
 *
 * Returns true when the viewport is at or below the mobile breakpoint (768px).
 * Uses useSyncExternalStore for tear-free reads.
 */

import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = '(max-width: 768px)';

function subscribe(callback: () => void): () => void {
	const mediaQueryList = globalThis.matchMedia(MOBILE_BREAKPOINT);
	mediaQueryList.addEventListener('change', callback);
	return () => mediaQueryList.removeEventListener('change', callback);
}

function getSnapshot(): boolean {
	return globalThis.matchMedia(MOBILE_BREAKPOINT).matches;
}

function getServerSnapshot(): boolean {
	return false;
}

export function useIsMobile(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
