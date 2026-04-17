export interface EditorFontDefinition {
	slug: string;
	label: string;
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
export type EditorFont = (typeof EDITOR_FONTS)[number]['slug'];
export const EDITOR_FONT_SLUGS: readonly [EditorFont, ...EditorFont[]] = [
	EDITOR_FONTS[0].slug,
	...EDITOR_FONTS.slice(1).map((f) => f.slug),
];
export const DEFAULT_EDITOR_FONT: EditorFont = EDITOR_FONTS[0].slug;
function buildFontFamilies(): Record<EditorFont, string> {
	const result: Record<string, string> = {};
	for (const font of EDITOR_FONTS) {
		result[font.slug] = font.family;
	}
	// All EDITOR_FONTS slugs are EditorFont by definition, so the record is complete
	return result satisfies Record<EditorFont, string>;
}
export const EDITOR_FONT_FAMILIES: Record<EditorFont, string> = buildFontFamilies();
