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

export function useResolvedTheme(): 'light' | 'dark' {
	const colorScheme = useStore(selectColorScheme);
	const systemPrefersDark = useSyncExternalStore(subscribeToSystemTheme, getSystemPrefersDark);

	return colorScheme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : colorScheme;
}

/**
 * Returns the resolved theme ('light' | 'dark') based on the current
 * color scheme preference, and keeps the `.dark` class on `<html>` in sync.
 */
export function useTheme(): 'light' | 'dark' {
	const resolved = useResolvedTheme();

	useEffect(() => {
		document.documentElement.classList.toggle('dark', resolved === 'dark');
	}, [resolved]);

	return resolved;
}
