import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useResolvedTheme, useTheme } from './use-theme';

let currentColorScheme: 'light' | 'dark' | 'system' = 'dark';
let mediaQueryList: {
	matches: boolean;
	addEventListener: (eventName: string, listener: EventListenerOrEventListenerObject) => void;
	removeEventListener: (eventName: string, listener: EventListenerOrEventListenerObject) => void;
	trigger: (matches: boolean) => void;
};

vi.mock('@/lib/store', () => ({
	selectColorScheme: (state: { colorScheme: 'light' | 'dark' | 'system' }) => state.colorScheme,
	useStore: (selector: (state: { colorScheme: 'light' | 'dark' | 'system' }) => unknown) => selector({ colorScheme: currentColorScheme }),
}));

describe('useTheme', () => {
	const originalMatchMedia = globalThis.matchMedia;
	const listeners = new Set<EventListener>();

	beforeEach(() => {
		listeners.clear();
		currentColorScheme = 'dark';
		mediaQueryList = {
			matches: true,
			addEventListener: (eventName, listener) => {
				if (eventName === 'change' && typeof listener === 'function') {
					listeners.add(listener);
				}
			},
			removeEventListener: (eventName, listener) => {
				if (eventName === 'change' && typeof listener === 'function') {
					listeners.delete(listener);
				}
			},
			trigger: (matches) => {
				mediaQueryList.matches = matches;
				for (const listener of listeners) {
					listener(new Event('change'));
				}
			},
		};
		Object.defineProperty(globalThis, 'matchMedia', {
			configurable: true,
			value: vi.fn(() => mediaQueryList),
		});
		document.documentElement.classList.remove('dark');
	});

	afterEach(() => {
		Object.defineProperty(globalThis, 'matchMedia', {
			configurable: true,
			value: originalMatchMedia,
		});
		document.documentElement.classList.remove('dark');
	});

	it('returns the explicit color scheme without consulting system preference', () => {
		currentColorScheme = 'light';

		const { result, rerender } = renderHook(() => useResolvedTheme());
		expect(result.current).toBe('light');

		currentColorScheme = 'dark';
		rerender();
		expect(result.current).toBe('dark');
	});

	it('resolves system theme from matchMedia updates', () => {
		currentColorScheme = 'system';
		mediaQueryList.matches = false;

		const { result } = renderHook(() => useResolvedTheme());
		expect(result.current).toBe('light');

		act(() => {
			mediaQueryList.trigger(true);
		});

		expect(result.current).toBe('dark');
	});

	it('applies the dark class to the document element', () => {
		currentColorScheme = 'dark';
		const { rerender } = renderHook(() => useTheme());
		expect(document.documentElement.classList.contains('dark')).toBe(true);

		currentColorScheme = 'light';
		rerender();
		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});
});
