/**
 * CodeMirror Editor Component
 *
 * React wrapper for CodeMirror 6 with language support and theme.
 */

import { syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { useCallback, useEffect, useRef } from 'react';

import { createDiffExtensions } from '../lib/diff-extension';
import {
	createEditorExtensions,
	createTabSizeExtension,
	darkHighlightStyle,
	darkTheme,
	getLanguageExtension,
	lightHighlightStyle,
	lightTheme,
	readonlyExtension,
} from '../lib/extensions';

import type { DiffData } from '../lib/diff-decorations';

// =============================================================================
// Types
// =============================================================================

export interface CodeEditorProperties {
	/** Initial content of the editor */
	value: string;
	/** Filename for language detection */
	filename: string;
	/** Called when content changes */
	onChange?: (value: string) => void;
	/** Called when cursor position changes */
	onCursorChange?: (position: { line: number; column: number }) => void;
	/** Called when the editor loses focus (for auto-save on focus change) */
	onBlur?: () => void;
	/** Navigate to a specific position (line/column). Consumed once when set. */
	goToPosition?: { line: number; column: number };
	/** Called after goToPosition has been consumed so the parent can clear it */
	onGoToPositionConsumed?: () => void;
	/** Whether the editor is readonly */
	readonly?: boolean;
	/** Tab size (default: 2) */
	tabSize?: number;
	/** Inline diff data for AI change review */
	diffData?: DiffData;
	/** Called when the user accepts the diff via inline action bar */
	onDiffApprove?: () => void;
	/** Called when the user rejects the diff via inline action bar */
	onDiffReject?: () => void;
	/** Resolved color theme */
	resolvedTheme?: 'light' | 'dark';
	/** Additional extensions */
	extensions?: Extension[];
	/** CSS class name */
	className?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * CodeMirror 6 editor component.
 */
export function CodeEditor({
	value,
	filename,
	onChange,
	onCursorChange,
	onBlur,
	goToPosition,
	onGoToPositionConsumed,
	readonly = false,
	tabSize = 2,
	diffData,
	onDiffApprove,
	onDiffReject,
	resolvedTheme = 'dark',
	extensions: additionalExtensions = [],
	className,
}: CodeEditorProperties) {
	const containerReference = useRef<HTMLDivElement>(null);
	const viewReference = useRef<EditorView | undefined>(undefined);

	// Per-instance compartments for dynamic reconfiguration
	const languageCompartment = useRef(new Compartment()).current;
	const readonlyCompartment = useRef(new Compartment()).current;
	const tabSizeCompartment = useRef(new Compartment()).current;
	const diffCompartment = useRef(new Compartment()).current;
	const themeCompartment = useRef(new Compartment()).current;

	// Use refs for all callbacks so the CodeMirror extension (created once
	// at mount) always calls the latest version without needing to
	// reconfigure the editor.
	const onChangeReference = useRef(onChange);
	onChangeReference.current = onChange;
	const onCursorChangeReference = useRef(onCursorChange);
	onCursorChangeReference.current = onCursorChange;
	const onBlurReference = useRef(onBlur);
	onBlurReference.current = onBlur;
	const onDiffApproveReference = useRef(onDiffApprove);
	onDiffApproveReference.current = onDiffApprove;
	const onDiffRejectReference = useRef(onDiffReject);
	onDiffRejectReference.current = onDiffReject;

	// Create update listener extension — uses refs so it never goes stale
	const createUpdateListener = useCallback(() => {
		return EditorView.updateListener.of((update: ViewUpdate) => {
			if (update.docChanged) {
				onChangeReference.current?.(update.state.doc.toString());
			}

			if (update.selectionSet) {
				const position = update.state.selection.main.head;
				const line = update.state.doc.lineAt(position);
				onCursorChangeReference.current?.({
					line: line.number,
					column: position - line.from + 1,
				});
			}

			if (update.focusChanged && !update.view.hasFocus) {
				onBlurReference.current?.();
			}
		});
	}, []);

	// Initialize editor
	useEffect(() => {
		if (!containerReference.current || viewReference.current) return;

		const langExtension = getLanguageExtension(filename);
		const baseExtensions = createEditorExtensions(filename, [createUpdateListener(), ...additionalExtensions], resolvedTheme);

		// Remove language from base extensions since we'll use compartment
		const diffExtensions = diffData
			? createDiffExtensions({
					hunks: diffData.hunks,
					onApprove: () => onDiffApproveReference.current?.(),
					onReject: () => onDiffRejectReference.current?.(),
				})
			: [];
		const isDark = resolvedTheme === 'dark';

		const extensions = [
			...baseExtensions,
			languageCompartment.of(langExtension ?? []),
			readonlyCompartment.of(readonly ? readonlyExtension : []),
			tabSizeCompartment.of(createTabSizeExtension(tabSize)),
			diffCompartment.of(diffExtensions),
			themeCompartment.of([isDark ? darkTheme : lightTheme, syntaxHighlighting(isDark ? darkHighlightStyle : lightHighlightStyle)]),
		];

		const state = EditorState.create({
			doc: value,
			extensions,
		});

		const view = new EditorView({
			state,
			parent: containerReference.current,
		});

		viewReference.current = view;

		return () => {
			view.destroy();
			viewReference.current = undefined;
		};
		/* eslint-disable react-hooks/exhaustive-deps, react-compiler/react-compiler -- mount-only effect for imperative CodeMirror setup */
	}, []);
	/* eslint-enable react-hooks/exhaustive-deps, react-compiler/react-compiler */

	// Update content when value prop changes
	useEffect(() => {
		if (!viewReference.current) return;

		const currentDocument = viewReference.current.state.doc.toString();
		if (currentDocument !== value) {
			viewReference.current.dispatch({
				changes: {
					from: 0,
					to: currentDocument.length,
					insert: value,
				},
			});
		}
	}, [value]);

	// Update language when filename changes
	useEffect(() => {
		if (!viewReference.current) return;

		const langExtension = getLanguageExtension(filename);
		viewReference.current.dispatch({
			effects: languageCompartment.reconfigure(langExtension ?? []),
		});
	}, [filename, languageCompartment]);

	// Update readonly state
	useEffect(() => {
		if (!viewReference.current) return;

		viewReference.current.dispatch({
			effects: readonlyCompartment.reconfigure(readonly ? readonlyExtension : []),
		});
	}, [readonly, readonlyCompartment]);

	// Update tab size
	useEffect(() => {
		if (!viewReference.current) return;

		viewReference.current.dispatch({
			effects: tabSizeCompartment.reconfigure(createTabSizeExtension(tabSize)),
		});
	}, [tabSize, tabSizeCompartment]);

	// Update theme
	useEffect(() => {
		if (!viewReference.current) return;

		const isDark = resolvedTheme === 'dark';
		viewReference.current.dispatch({
			effects: themeCompartment.reconfigure([
				isDark ? darkTheme : lightTheme,
				syntaxHighlighting(isDark ? darkHighlightStyle : lightHighlightStyle),
			]),
		});
	}, [resolvedTheme, themeCompartment]);

	// Update diff decorations
	useEffect(() => {
		if (!viewReference.current) return;

		const diffExtensions = diffData
			? createDiffExtensions({
					hunks: diffData.hunks,
					onApprove: () => onDiffApproveReference.current?.(),
					onReject: () => onDiffRejectReference.current?.(),
				})
			: [];
		viewReference.current.dispatch({
			effects: diffCompartment.reconfigure(diffExtensions),
		});
	}, [diffData, diffCompartment]);

	// Navigate to a specific position when goToPosition is set
	useEffect(() => {
		if (!goToPosition || !viewReference.current) return;

		const view = viewReference.current;
		const document_ = view.state.doc;

		// Clamp line number to valid range
		const lineNumber = Math.max(1, Math.min(goToPosition.line, document_.lines));
		const line = document_.line(lineNumber);

		// Clamp column to valid range within the line
		const column = Math.max(1, Math.min(goToPosition.column, line.length + 1));
		const position = line.from + column - 1;

		view.dispatch({
			selection: { anchor: position },
			scrollIntoView: true,
		});

		// Focus the editor so the cursor is visible
		view.focus();

		onGoToPositionConsumed?.();
	}, [goToPosition, onGoToPositionConsumed]);

	return (
		<div
			ref={containerReference}
			className={`
				size-full overflow-hidden
				${className ?? ''}
			`}
			data-testid="code-editor"
		/>
	);
}

// =============================================================================
// Hooks for external control
// =============================================================================

/**
 * Hook to get editor view reference for external control.
 */
// eslint-disable-next-line react-refresh/only-export-components -- hook co-located with editor component
export function useEditorReference() {
	const viewReference = useRef<EditorView | undefined>(undefined);

	const setView = useCallback((view: EditorView | undefined) => {
		viewReference.current = view;
	}, []);

	const getView = useCallback(() => viewReference.current, []);

	return { setView, getView };
}
