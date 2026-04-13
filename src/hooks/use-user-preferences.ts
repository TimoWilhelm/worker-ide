/**
 * User Preferences Hook
 *
 * Fetches user preferences from the server on mount, applies them to the
 * Zustand store, and writes a global localStorage cache for the FOUC
 * prevention script. Subscribes to store changes and persists them back
 * to the server in the background.
 */

import { useEffect, useRef } from 'react';

import { fetchUserPreferences, updateUserPreferences } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { EDITOR_FONT_SLUGS, USER_PREFERENCE_KEYS } from '@shared/constants';

import type { EditorFont, UserPreferences } from '@shared/constants';

type ColorScheme = 'light' | 'dark' | 'system';

/** Global localStorage key used by the FOUC-prevention script. */
const PREFERENCES_CACHE_KEY = 'worker-ide-preferences';

const COLOR_SCHEMES = new Set<string>(['light', 'dark', 'system']);

function isColorScheme(value: string): value is ColorScheme {
	return COLOR_SCHEMES.has(value);
}

const EDITOR_FONT_SET = new Set<string>(EDITOR_FONT_SLUGS);

function isEditorFont(value: string): value is EditorFont {
	return EDITOR_FONT_SET.has(value);
}

/** Write the current preferences to the global localStorage cache. */
function writeLocalCache(preferences: UserPreferences): void {
	try {
		globalThis.localStorage.setItem(PREFERENCES_CACHE_KEY, JSON.stringify(preferences));
	} catch {
		// localStorage may be unavailable (private mode, storage full, etc.)
	}
}

/** Apply fetched preferences to the Zustand store, validating each value. */
function applyPreferencesToStore(preferences: UserPreferences): void {
	const { setColorScheme, setEditorFont } = useStore.getState();

	if (isColorScheme(preferences.colorScheme)) {
		setColorScheme(preferences.colorScheme);
	}

	if (isEditorFont(preferences.editorFont)) {
		setEditorFont(preferences.editorFont);
	}
}

/** Read the current preference values from the store. */
function readPreferencesFromStore(): UserPreferences {
	const state = useStore.getState();
	return {
		colorScheme: state.colorScheme,
		editorFont: state.editorFont,
	};
}

/**
 * Sync user preferences between the server, Zustand store, and localStorage.
 *
 * - On mount: fetches from server → applies to store + localStorage cache.
 * - On store change: persists diff to server + updates localStorage cache.
 */
export function useUserPreferences(): void {
	/** Tracks the last-known server state to compute diffs. */
	const serverStateReference = useRef<Record<string, string> | undefined>(undefined);

	/** Prevents the subscription from writing back values we just applied from the server. */
	const suppressWriteBackReference = useRef(false);

	// Fetch on mount
	useEffect(() => {
		let cancelled = false;

		void fetchUserPreferences().then((preferences) => {
			if (cancelled) return;
			serverStateReference.current = { ...preferences };
			suppressWriteBackReference.current = true;
			applyPreferencesToStore(preferences);
			writeLocalCache(preferences);
			// Allow write-back after the store settles
			queueMicrotask(() => {
				suppressWriteBackReference.current = false;
			});
		});

		return () => {
			cancelled = true;
		};
	}, []);

	// Subscribe to store changes and persist diffs
	useEffect(() => {
		const unsubscribe = useStore.subscribe(() => {
			if (suppressWriteBackReference.current) return;
			const current = readPreferencesFromStore();
			const previous = serverStateReference.current;

			// Compute changed keys
			const diff: Record<string, string> = {};
			for (const key of USER_PREFERENCE_KEYS) {
				if (current[key] !== previous?.[key]) {
					diff[key] = current[key];
				}
			}

			if (Object.keys(diff).length === 0) return;

			// Update references immediately so we don't re-send
			serverStateReference.current = { ...serverStateReference.current, ...diff };
			writeLocalCache(current);

			// Fire-and-forget server write
			void updateUserPreferences(diff);
		});

		return unsubscribe;
	}, []);
}
