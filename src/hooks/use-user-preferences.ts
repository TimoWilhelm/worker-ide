import { useEffect, useRef } from 'react';

import { fetchUserPreferences, updateUserPreferences } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { EDITOR_FONT_SLUGS, USER_PREFERENCE_KEYS } from '@shared/constants';

import type { EditorFont, UserPreferences } from '@shared/constants';

type ColorScheme = 'light' | 'dark' | 'system';
const PREFERENCES_CACHE_KEY = 'worker-ide-preferences';

const PREFERENCES_CHANNEL_NAME = 'worker-ide-preferences';

const COLOR_SCHEMES = new Set<string>(['light', 'dark', 'system']);

function isColorScheme(value: string): value is ColorScheme {
	return COLOR_SCHEMES.has(value);
}

const EDITOR_FONT_SET = new Set<string>(EDITOR_FONT_SLUGS);

function isEditorFont(value: string): value is EditorFont {
	return EDITOR_FONT_SET.has(value);
}

function writeLocalCache(preferences: UserPreferences): void {
	try {
		globalThis.localStorage.setItem(PREFERENCES_CACHE_KEY, JSON.stringify(preferences));
	} catch {
		// localStorage may be unavailable (private mode, storage full, etc.)
	}
}

function applyPreferencesToStore(preferences: UserPreferences): void {
	const { setColorScheme, setEditorFont } = useStore.getState();

	if (isColorScheme(preferences.colorScheme)) {
		setColorScheme(preferences.colorScheme);
	}

	if (isEditorFont(preferences.editorFont)) {
		setEditorFont(preferences.editorFont);
	}
}

function readPreferencesFromStore(): UserPreferences {
	const state = useStore.getState();
	return {
		colorScheme: state.colorScheme,
		editorFont: state.editorFont,
	};
}

export function useUserPreferences(): void {
	const serverStateReference = useRef<Record<string, string> | undefined>(undefined);
	const suppressWriteBackReference = useRef(false);

	useEffect(() => {
		let cancelled = false;

		void fetchUserPreferences().then((preferences) => {
			if (cancelled) return;
			serverStateReference.current = { ...preferences };
			suppressWriteBackReference.current = true;
			applyPreferencesToStore(preferences);
			writeLocalCache(preferences);
			queueMicrotask(() => {
				suppressWriteBackReference.current = false;
			});
		});

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		let channel: BroadcastChannel | undefined;
		try {
			channel = new BroadcastChannel(PREFERENCES_CHANNEL_NAME);
		} catch {
			// BroadcastChannel may be unavailable in some environments
		}

		const handleChannelMessage = (event: MessageEvent<unknown>) => {
			const raw = event.data;
			if (typeof raw !== 'object' || !raw) return;
			const validated: Partial<UserPreferences> = {};
			if ('colorScheme' in raw && typeof raw.colorScheme === 'string' && isColorScheme(raw.colorScheme)) {
				validated.colorScheme = raw.colorScheme;
			}
			if ('editorFont' in raw && typeof raw.editorFont === 'string' && isEditorFont(raw.editorFont)) {
				validated.editorFont = raw.editorFont;
			}
			if (Object.keys(validated).length === 0) return;

			suppressWriteBackReference.current = true;
			const merged: UserPreferences = { ...readPreferencesFromStore(), ...validated };
			serverStateReference.current = { ...serverStateReference.current, ...validated };
			applyPreferencesToStore(merged);
			writeLocalCache(merged);
			queueMicrotask(() => {
				suppressWriteBackReference.current = false;
			});
		};

		channel?.addEventListener('message', handleChannelMessage);

		const unsubscribe = useStore.subscribe(() => {
			if (suppressWriteBackReference.current) return;
			const current = readPreferencesFromStore();
			const previous = serverStateReference.current;

			const diff: Record<string, string> = {};
			for (const key of USER_PREFERENCE_KEYS) {
				if (current[key] !== previous?.[key]) {
					diff[key] = current[key];
				}
			}

			if (Object.keys(diff).length === 0) return;

			serverStateReference.current = { ...serverStateReference.current, ...diff };
			writeLocalCache(current);

			try {
				channel?.postMessage(current);
			} catch {
				// Channel may have been closed
			}

			void updateUserPreferences(diff);
		});

		return () => {
			unsubscribe();
			channel?.removeEventListener('message', handleChannelMessage);
			try {
				channel?.close();
			} catch {
				// Ignore close errors
			}
		};
	}, []);
}
