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
 * Dark theme matching the IDE design system.
 */
export const darkTheme = EditorView.theme(
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
		},
		'.cm-cursor, .cm-dropCursor': {
			borderLeftColor: 'var(--color-accent)',
		},
		'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
			backgroundColor: 'rgba(88, 166, 255, 0.2)',
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
			backgroundColor: 'rgba(88, 166, 255, 0.3)',
			outline: '1px solid rgba(88, 166, 255, 0.5)',
		},
		'.cm-searchMatch.cm-searchMatch-selected': {
			backgroundColor: 'rgba(88, 166, 255, 0.5)',
		},
		'.cm-activeLine': {
			backgroundColor: 'rgba(88, 166, 255, 0.05)',
		},
		'.cm-selectionMatch': {
			backgroundColor: 'rgba(88, 166, 255, 0.15)',
		},
		'&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
			backgroundColor: 'rgba(88, 166, 255, 0.3)',
			outline: '1px solid rgba(88, 166, 255, 0.5)',
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
	{ dark: true },
);

// =============================================================================
// Syntax Highlighting
// =============================================================================

/**
 * Syntax highlighting colors for dark theme.
 */
export const darkHighlightStyle = HighlightStyle.define([
	{ tag: t.keyword, color: '#ff7b72' },
	{ tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: '#79c0ff' },
	{ tag: [t.function(t.variableName), t.labelName], color: '#d2a8ff' },
	{ tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#79c0ff' },
	{ tag: [t.definition(t.name), t.separator], color: '#e6edf3' },
	{ tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#ffa657' },
	{ tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#79c0ff' },
	{ tag: [t.meta, t.comment], color: '#8b949e' },
	{ tag: t.strong, fontWeight: 'bold' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: t.strikethrough, textDecoration: 'line-through' },
	{ tag: t.link, color: '#58a6ff', textDecoration: 'underline' },
	{ tag: t.heading, fontWeight: 'bold', color: '#79c0ff' },
	{ tag: [t.atom, t.bool, t.special(t.variableName)], color: '#79c0ff' },
	{ tag: [t.processingInstruction, t.string, t.inserted], color: '#a5d6ff' },
	{ tag: t.invalid, color: '#f85149' },
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
export function getBaseExtensions(): Extension[] {
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
		syntaxHighlighting(darkHighlightStyle),
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
		darkTheme,
		EditorView.lineWrapping,
	];
}

/**
 * Create a complete set of extensions for a file.
 */
export function createEditorExtensions(filename: string, additionalExtensions: Extension[] = []): Extension[] {
	const extensions = getBaseExtensions();

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
