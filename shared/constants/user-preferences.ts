import { DEFAULT_EDITOR_FONT } from './editor-fonts';

/**
 * Canonical map of every active user preference key to its default value.
 *
 * All values are strings because they are stored as text in the DB.
 * Consumers parse/validate them as needed.
 */
export const USER_PREFERENCE_DEFAULTS = {
	colorScheme: 'dark',
	editorFont: DEFAULT_EDITOR_FONT,
} as const satisfies Record<string, string>;
export type UserPreferenceKey = keyof typeof USER_PREFERENCE_DEFAULTS;
export const USER_PREFERENCE_KEYS: UserPreferenceKey[] = Object.keys(USER_PREFERENCE_DEFAULTS).filter(
	(key): key is UserPreferenceKey => key in USER_PREFERENCE_DEFAULTS,
);
export interface UserPreferences {
	colorScheme: string;
	editorFont: string;
}
export function isValidPreferenceKey(key: string): key is UserPreferenceKey {
	return key in USER_PREFERENCE_DEFAULTS;
}

/**
 * Merge stored rows with defaults to produce a complete preferences object.
 *
 * - Missing keys are filled from USER_PREFERENCE_DEFAULTS.
 * - Stale/deprecated keys present in `stored` but absent from the defaults
 *   map are silently dropped.
 */
export function resolveUserPreferences(stored: Partial<Record<string, string>>): UserPreferences {
	return {
		colorScheme: stored.colorScheme ?? USER_PREFERENCE_DEFAULTS.colorScheme,
		editorFont: stored.editorFont ?? USER_PREFERENCE_DEFAULTS.editorFont,
	};
}
