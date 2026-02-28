/**
 * Online Status Hook
 *
 * Tracks the browser's online/offline state via `navigator.onLine`
 * and the `online`/`offline` window events.
 */

import { useSyncExternalStore } from 'react';

function subscribe(callback: () => void): () => void {
	globalThis.addEventListener('online', callback);
	globalThis.addEventListener('offline', callback);
	return () => {
		globalThis.removeEventListener('online', callback);
		globalThis.removeEventListener('offline', callback);
	};
}

function getSnapshot(): boolean {
	return navigator.onLine;
}

function getServerSnapshot(): boolean {
	return true;
}

/**
 * Returns `true` when the browser reports it is online, `false` when offline.
 *
 * Uses `useSyncExternalStore` for tear-free reads — no useEffect / useState.
 */
export function useOnlineStatus(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
