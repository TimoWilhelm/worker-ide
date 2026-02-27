/**
 * CodeMirror Editor Component
 *
 * React wrapper for CodeMirror 6 with language support and theme.
 */

import { syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { useCallback, useEffect, useRef } from 'react';

import { createAiActionBarExtension, createDiffDecorations } from '../lib/diff-extension';
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
import { createLintExtension } from '../lib/lint-extension';

import type { DiffData } from '../lib/diff-decorations';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build diff extensions: core decorations always, AI action bar only when
 * approve/reject callbacks are provided. This ensures git diffs never show
 * the AI accept/reject bar.
 */
function buildDiffExtensions(
	diffData: DiffData,
	hunkStatuses: Array<'pending' | 'approved' | 'rejected'>,
	onApproveReference: React.RefObject<((groupIndex: number) => void) | undefined>,
	onRejectReference: React.RefObject<((groupIndex: number) => void) | undefined>,
): Extension[] {
	const extensions = createDiffDecorations(diffData.hunks, hunkStatuses);

	// Only add the AI action bar when both callbacks are provided
	const onApprove = onApproveReference.current;
	const onReject = onRejectReference.current;
	if (onApprove && onReject) {
		extensions.push(...createAiActionBarExtension(diffData.hunks, hunkStatuses, onApprove, onReject));
	}

	return extensions;
}

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
	/** Per-change-group statuses for filtering resolved hunks from decorations */
	hunkStatuses?: Array<'pending' | 'approved' | 'rejected'>;
	/** Called when the user accepts a change group via inline action bar */
	onDiffApprove?: (groupIndex: number) => void;
	/** Called when the user rejects a change group via inline action bar */
	onDiffReject?: (groupIndex: number) => void;
	/** Resolved color theme */
	resolvedTheme?: 'light' | 'dark';
	/** Additional extensions */
	extensions?: Extension[];
	/** CSS class name */
	className?: string;
	/** Called with the EditorView when it is created (and no argument when destroyed) */
	onViewReady?: (view?: EditorView) => void;
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
	hunkStatuses = [],
	onDiffApprove,
	onDiffReject,
	resolvedTheme = 'dark',
	extensions: additionalExtensions = [],
	className,
	onViewReady,
}: CodeEditorProperties) {
	const containerReference = useRef<HTMLDivElement>(null);
	const viewReference = useRef<EditorView | undefined>(undefined);

	// Per-instance compartments for dynamic reconfiguration
	const languageCompartment = useRef(new Compartment()).current;
	const readonlyCompartment = useRef(new Compartment()).current;
	const tabSizeCompartment = useRef(new Compartment()).current;
	const diffCompartment = useRef(new Compartment()).current;
	const lintCompartment = useRef(new Compartment()).current;
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
	const onViewReadyReference = useRef(onViewReady);
	onViewReadyReference.current = onViewReady;
	const hunkStatusesReference = useRef(hunkStatuses);
	hunkStatusesReference.current = hunkStatuses;
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
		const baseExtensions = createEditorExtensions([createUpdateListener(), ...additionalExtensions]);

		// Build diff extensions: core decorations always, AI action bar only when callbacks provided
		const diffExtensions = diffData
			? buildDiffExtensions(diffData, hunkStatusesReference.current, onDiffApproveReference, onDiffRejectReference)
			: [];
		const isDark = resolvedTheme === 'dark';

		const lintExtensions = readonly ? [] : createLintExtension(filename);

		const extensions = [
			...baseExtensions,
			languageCompartment.of(langExtension ?? []),
			readonlyCompartment.of(readonly ? readonlyExtension : []),
			tabSizeCompartment.of(createTabSizeExtension(tabSize)),
			diffCompartment.of(diffExtensions),
			lintCompartment.of(lintExtensions),
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
		onViewReadyReference.current?.(view);

		return () => {
			onViewReadyReference.current?.();
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

	// Update language and lint when filename changes
	useEffect(() => {
		if (!viewReference.current) return;

		const langExtension = getLanguageExtension(filename);
		const lintExtensions = readonly ? [] : createLintExtension(filename);
		viewReference.current.dispatch({
			effects: [languageCompartment.reconfigure(langExtension ?? []), lintCompartment.reconfigure(lintExtensions)],
		});
	}, [filename, readonly, languageCompartment, lintCompartment]);

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
			? buildDiffExtensions(diffData, hunkStatusesReference.current, onDiffApproveReference, onDiffRejectReference)
			: [];
		viewReference.current.dispatch({
			effects: diffCompartment.reconfigure(diffExtensions),
		});
	}, [diffData, hunkStatuses, diffCompartment]);

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
