/**
 * User Preference Constants
 *
 * Single source of truth for all user preference keys and their defaults.
 * The DB stores preferences as key-value rows. This map defines which keys
 * are currently valid and what their defaults are.
 *
 * **To add a new preference:**
 *   1. Add an entry to USER_PREFERENCE_DEFAULTS below.
 *   2. Wire it into the Zustand store (state field + action).
 *   3. Read/write it via the existing GET/PUT /user/preferences API.
 *   No database migration is needed — missing keys fall back to the default.
 *
 * **To deprecate/remove a preference:**
 *   1. Remove the entry from USER_PREFERENCE_DEFAULTS below.
 *   Stale rows in the DB are silently ignored on read and rejected on write.
 *   They can be cleaned up lazily or left as no-ops.
 */

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

/** Union type of valid preference keys. */
export type UserPreferenceKey = keyof typeof USER_PREFERENCE_DEFAULTS;

/** All valid preference keys as an array. */
export const USER_PREFERENCE_KEYS: UserPreferenceKey[] = Object.keys(USER_PREFERENCE_DEFAULTS).filter(
	(key): key is UserPreferenceKey => key in USER_PREFERENCE_DEFAULTS,
);

/** The resolved preferences object (all current keys guaranteed present). */
export interface UserPreferences {
	colorScheme: string;
	editorFont: string;
}

/** Type guard: returns true if `key` is a currently valid preference key. */
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
