/**
 * Editor Font Constants
 *
 * Single source of truth for all available monospace fonts.
 * To add a new font:
 *   1. Add an entry to EDITOR_FONTS below.
 *   2. Add the Google Font to the `<link>` tag in `index.html`.
 *
 * Everything else (Zod schema, store type, FOUC-prevention script, hook,
 * appearance UI) derives automatically from this array.
 */

export interface EditorFontDefinition {
	/** Unique slug persisted to localStorage (kebab-case). */
	slug: string;
	/** Human-readable label shown in the UI. */
	label: string;
	/** CSS `font-family` value. */
	family: string;
}

/**
 * Canonical list of available editor fonts.
 * The first entry is used as the default.
 */
export const EDITOR_FONTS = [
	{ slug: 'space-mono', label: 'Space Mono', family: "'Space Mono', monospace" },
	{ slug: 'jetbrains-mono', label: 'JetBrains Mono', family: "'JetBrains Mono', monospace" },
] as const satisfies readonly EditorFontDefinition[];

/** Union type of valid editor font slugs. */
export type EditorFont = (typeof EDITOR_FONTS)[number]['slug'];

/** All valid editor font slugs as a tuple (useful for Zod enums). */
export const EDITOR_FONT_SLUGS: readonly [EditorFont, ...EditorFont[]] = [
	EDITOR_FONTS[0].slug,
	...EDITOR_FONTS.slice(1).map((f) => f.slug),
];

/** Default editor font slug. */
export const DEFAULT_EDITOR_FONT: EditorFont = EDITOR_FONTS[0].slug;

/** Build a typed record from font definitions. */
function buildFontFamilies(): Record<EditorFont, string> {
	const result: Record<string, string> = {};
	for (const font of EDITOR_FONTS) {
		result[font.slug] = font.family;
	}
	// All EDITOR_FONTS slugs are EditorFont by definition, so the record is complete
	return result satisfies Record<EditorFont, string>;
}

/** Map from slug to CSS font-family string. */
export const EDITOR_FONT_FAMILIES: Record<EditorFont, string> = buildFontFamilies();
