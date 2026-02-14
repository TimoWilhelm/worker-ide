/**
 * CodeMirror Extensions Configuration
 *
 * Sets up language support, themes, and editor features.
 */

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import {
	bracketMatching,
	defaultHighlightStyle,
	foldGutter,
	foldKeymap,
	indentOnInput,
	syntaxHighlighting,
	HighlightStyle,
} from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import {
	crosshairCursor,
	drawSelection,
	dropCursor,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

import type { Extension } from '@codemirror/state';

// =============================================================================
// Theme
// =============================================================================

/**
 * Shared editor theme styles (adapts via CSS variables).
 */
function createEditorTheme(isDark: boolean) {
	return EditorView.theme(
		{
			'&': {
				backgroundColor: 'var(--color-bg-secondary)',
				color: 'var(--color-text-primary)',
				height: '100%',
			},
			'.cm-content': {
				caretColor: 'var(--color-accent)',
				fontFamily: 'var(--font-mono)',
				fontSize: 'var(--text-base)',
				padding: '4px 0',
			},
			'.cm-cursor, .cm-dropCursor': {
				borderLeftColor: 'var(--color-accent)',
			},
			'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
				backgroundColor: isDark ? 'rgba(241, 70, 2, 0.2)' : 'rgba(255, 72, 1, 0.15)',
			},
			'.cm-panels': {
				backgroundColor: 'var(--color-bg-tertiary)',
				color: 'var(--color-text-primary)',
			},
			'.cm-panels.cm-panels-top': {
				borderBottom: '1px solid var(--color-border)',
			},
			'.cm-panels.cm-panels-bottom': {
				borderTop: '1px solid var(--color-border)',
			},
			'.cm-searchMatch': {
				backgroundColor: isDark ? 'rgba(241, 70, 2, 0.25)' : 'rgba(255, 72, 1, 0.2)',
				outline: isDark ? '1px solid rgba(241, 70, 2, 0.5)' : '1px solid rgba(255, 72, 1, 0.4)',
			},
			'.cm-searchMatch.cm-searchMatch-selected': {
				backgroundColor: isDark ? 'rgba(241, 70, 2, 0.45)' : 'rgba(255, 72, 1, 0.35)',
			},
			'.cm-activeLine': {
				backgroundColor: isDark ? 'rgba(241, 70, 2, 0.06)' : 'rgba(255, 72, 1, 0.05)',
			},
			'.cm-selectionMatch': {
				backgroundColor: isDark ? 'rgba(241, 70, 2, 0.12)' : 'rgba(255, 72, 1, 0.1)',
			},
			'&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
				backgroundColor: isDark ? 'rgba(241, 70, 2, 0.25)' : 'rgba(255, 72, 1, 0.2)',
				outline: isDark ? '1px solid rgba(241, 70, 2, 0.5)' : '1px solid rgba(255, 72, 1, 0.4)',
			},
			'.cm-gutters': {
				backgroundColor: 'var(--color-bg-secondary)',
				color: 'var(--color-text-secondary)',
				border: 'none',
				borderRight: '1px solid var(--color-border)',
			},
			'.cm-activeLineGutter': {
				backgroundColor: 'var(--color-bg-tertiary)',
				color: 'var(--color-text-primary)',
			},
			'.cm-foldPlaceholder': {
				backgroundColor: 'var(--color-bg-tertiary)',
				border: 'none',
				color: 'var(--color-text-secondary)',
			},
			'.cm-tooltip': {
				backgroundColor: 'var(--color-bg-tertiary)',
				border: '1px solid var(--color-border)',
				borderRadius: '4px',
			},
			'.cm-tooltip .cm-tooltip-arrow:before': {
				borderTopColor: 'var(--color-border)',
			},
			'.cm-tooltip .cm-tooltip-arrow:after': {
				borderTopColor: 'var(--color-bg-tertiary)',
			},
			'.cm-tooltip-autocomplete': {
				'& > ul > li[aria-selected]': {
					backgroundColor: 'var(--color-accent)',
					color: 'white',
				},
			},
		},
		{ dark: isDark },
	);
}

export const darkTheme = createEditorTheme(true);
export const lightTheme = createEditorTheme(false);

// =============================================================================
// Syntax Highlighting
// =============================================================================

/**
 * Syntax highlighting colors for dark theme.
 */
export const darkHighlightStyle = HighlightStyle.define([
	{ tag: t.keyword, color: '#ff7038' },
	{ tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: '#4db8ff' },
	{ tag: [t.function(t.variableName), t.labelName], color: '#b866ff' },
	{ tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#4db8ff' },
	{ tag: [t.definition(t.name), t.separator], color: '#f0e3de' },
	{ tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#ffc84d' },
	{ tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#4db8ff' },
	{ tag: [t.meta, t.comment], color: '#6b6562' },
	{ tag: t.strong, fontWeight: 'bold' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: t.strikethrough, textDecoration: 'line-through' },
	{ tag: t.link, color: '#ff6d33', textDecoration: 'underline' },
	{ tag: t.heading, fontWeight: 'bold', color: '#4db8ff' },
	{ tag: [t.atom, t.bool, t.special(t.variableName)], color: '#4db8ff' },
	{ tag: [t.processingInstruction, t.string, t.inserted], color: '#5eff3a' },
	{ tag: t.invalid, color: '#ff5e5e' },
]);

/**
 * Syntax highlighting colors for light theme.
 */
export const lightHighlightStyle = HighlightStyle.define([
	{ tag: t.keyword, color: '#d63a00' },
	{ tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: '#0070c9' },
	{ tag: [t.function(t.variableName), t.labelName], color: '#7b30c9' },
	{ tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#0070c9' },
	{ tag: [t.definition(t.name), t.separator], color: '#521000' },
	{ tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#a06800' },
	{ tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#0070c9' },
	{ tag: [t.meta, t.comment], color: '#9b8e87' },
	{ tag: t.strong, fontWeight: 'bold' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: t.strikethrough, textDecoration: 'line-through' },
	{ tag: t.link, color: '#d63a00', textDecoration: 'underline' },
	{ tag: t.heading, fontWeight: 'bold', color: '#0070c9' },
	{ tag: [t.atom, t.bool, t.special(t.variableName)], color: '#0070c9' },
	{ tag: [t.processingInstruction, t.string, t.inserted], color: '#067d00' },
	{ tag: t.invalid, color: '#d10000' },
]);

// =============================================================================
// Language Support
// =============================================================================

/**
 * Get the appropriate language extension for a file.
 */
export function getLanguageExtension(filename: string): Extension | undefined {
	const extension = filename.split('.').pop()?.toLowerCase();

	switch (extension) {
		case 'ts':
		case 'tsx': {
			return javascript({ jsx: true, typescript: true });
		}
		case 'js':
		case 'jsx':
		case 'mjs': {
			return javascript({ jsx: true });
		}
		case 'css': {
			return css();
		}
		case 'html': {
			return html();
		}
		case 'json': {
			return json();
		}
		default: {
			return undefined;
		}
	}
}

// =============================================================================
// Base Extensions
// =============================================================================

/**
 * Basic editor extensions for all files.
 */
export function getBaseExtensions(resolvedTheme: 'light' | 'dark' = 'dark'): Extension[] {
	const isDark = resolvedTheme === 'dark';
	return [
		lineNumbers(),
		highlightActiveLineGutter(),
		highlightSpecialChars(),
		history(),
		foldGutter(),
		drawSelection(),
		dropCursor(),
		EditorState.allowMultipleSelections.of(true),
		indentOnInput(),
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		syntaxHighlighting(isDark ? darkHighlightStyle : lightHighlightStyle),
		bracketMatching(),
		closeBrackets(),
		autocompletion(),
		rectangularSelection(),
		crosshairCursor(),
		highlightActiveLine(),
		highlightSelectionMatches(),
		keymap.of([
			...closeBracketsKeymap,
			...defaultKeymap,
			...searchKeymap,
			...historyKeymap,
			...foldKeymap,
			...completionKeymap,
			...lintKeymap,
			indentWithTab,
		]),
		isDark ? darkTheme : lightTheme,
	];
}

/**
 * Create a complete set of extensions for a file.
 */
export function createEditorExtensions(
	filename: string,
	additionalExtensions: Extension[] = [],
	resolvedTheme: 'light' | 'dark' = 'dark',
): Extension[] {
	const extensions = getBaseExtensions(resolvedTheme);

	const langExtension = getLanguageExtension(filename);
	if (langExtension) {
		extensions.push(langExtension);
	}

	extensions.push(...additionalExtensions);

	return extensions;
}

// =============================================================================
// Readonly Extension
// =============================================================================

/**
 * Extension to make the editor readonly.
 */
export const readonlyExtension = EditorState.readOnly.of(true);

// =============================================================================
// Tab Size Extension
// =============================================================================

/**
 * Create tab size extension.
 */
export function createTabSizeExtension(tabSize: number = 2): Extension {
	return EditorState.tabSize.of(tabSize);
}
