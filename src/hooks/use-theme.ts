/**
 * Theme Hook
 *
 * Syncs the color scheme preference from the store to the `<html>` element
 * by toggling the `.dark` class. Supports 'light', 'dark', and 'system' modes.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { selectColorScheme, useStore } from '@/lib/store';

const DARK_MQ = '(prefers-color-scheme: dark)';

function getSystemPrefersDark(): boolean {
	return globalThis.matchMedia?.(DARK_MQ).matches ?? true;
}

function subscribeToSystemTheme(callback: () => void): () => void {
	const mediaQuery = globalThis.matchMedia?.(DARK_MQ);
	if (!mediaQuery) return () => {};
	mediaQuery.addEventListener('change', callback);
	return () => mediaQuery.removeEventListener('change', callback);
}

/**
 * Returns the resolved theme ('light' | 'dark') based on the current
 * color scheme preference, and keeps the `.dark` class on `<html>` in sync.
 */
export function useTheme(): 'light' | 'dark' {
	const colorScheme = useStore(selectColorScheme);
	const systemPrefersDark = useSyncExternalStore(subscribeToSystemTheme, getSystemPrefersDark);

	const resolved: 'light' | 'dark' = colorScheme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : colorScheme;

	useEffect(() => {
		document.documentElement.classList.toggle('dark', resolved === 'dark');
	}, [resolved]);

	return resolved;
}
