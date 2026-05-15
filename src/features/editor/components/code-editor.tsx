import { syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { useCallback, useEffect, useMemo, useRef } from 'react';

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

/**
 * Build diff extensions: core decorations always, AI action bar only when
 * approve/reject callbacks are provided. This ensures git diffs never show
 * the AI accept/reject bar.
 */
function buildDiffExtensions(
	diffData: DiffData,
	hunkStatuses: Array<'pending' | 'approved' | 'rejected'>,
	hunkSessionReferences: Array<Array<{ sessionId: string; label: string }>>,
	onApproveReference: React.RefObject<((groupIndex: number) => void) | undefined>,
	onRejectReference: React.RefObject<((groupIndex: number) => void) | undefined>,
	onOpenSessionReference: React.RefObject<((sessionId: string) => void) | undefined>,
): Extension[] {
	const extensions = createDiffDecorations(diffData.hunks, hunkStatuses);

	// Only add the AI action bar when both callbacks are provided
	const onApprove = onApproveReference.current;
	const onReject = onRejectReference.current;
	if (onApprove && onReject) {
		extensions.push(
			...createAiActionBarExtension(
				diffData.hunks,
				hunkStatuses,
				hunkSessionReferences,
				onApprove,
				onReject,
				onOpenSessionReference.current,
			),
		);
	}

	return extensions;
}

export interface CodeEditorProperties {
	/**
	 * Required for in-editor linting; lint requests are scoped per project.
	 * When omitted, lint extensions are disabled (e.g. tests that render the
	 * editor in isolation).
	 */
	projectId?: string;
	value: string;
	filename: string;
	onChange?: (value: string) => void;
	onCursorChange?: (position: { line: number; column: number; anchorLine: number; anchorColumn: number }) => void;
	onBlur?: () => void;
	goToPosition?: { line: number; column: number };
	onGoToPositionConsumed?: () => void;
	readonly?: boolean;
	tabSize?: number;
	diffData?: DiffData;
	hunkStatuses?: Array<'pending' | 'approved' | 'rejected'>;
	hunkSessionReferences?: Array<Array<{ sessionId: string; label: string }>>;
	onDiffApprove?: (groupIndex: number) => void;
	onDiffReject?: (groupIndex: number) => void;
	onOpenDiffSession?: (sessionId: string) => void;
	resolvedTheme?: 'light' | 'dark';
	extensions?: Extension[];
	className?: string;
	onViewReady?: (view?: EditorView) => void;
}
export function CodeEditor({
	projectId,
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
	hunkSessionReferences = [],
	onDiffApprove,
	onDiffReject,
	onOpenDiffSession,
	resolvedTheme = 'dark',
	extensions: additionalExtensions = [],
	className,
	onViewReady,
}: CodeEditorProperties) {
	const containerReference = useRef<HTMLDivElement>(null);
	const viewReference = useRef<EditorView | undefined>(undefined);

	const languageCompartment = useMemo(() => new Compartment(), []);
	const readonlyCompartment = useMemo(() => new Compartment(), []);
	const tabSizeCompartment = useMemo(() => new Compartment(), []);
	const diffCompartment = useMemo(() => new Compartment(), []);
	const lintCompartment = useMemo(() => new Compartment(), []);
	const themeCompartment = useMemo(() => new Compartment(), []);

	// Use refs for all callbacks so the CodeMirror extension (created once
	// at mount) always calls the latest version without needing to
	// reconfigure the editor.
	const onChangeReference = useRef(onChange);
	const onCursorChangeReference = useRef(onCursorChange);
	const onBlurReference = useRef(onBlur);
	const onViewReadyReference = useRef(onViewReady);
	const isApplyingExternalValueReference = useRef(false);
	const hunkStatusesReference = useRef(hunkStatuses);
	const hunkSessionReferencesReference = useRef(hunkSessionReferences);
	const onDiffApproveReference = useRef(onDiffApprove);
	const onDiffRejectReference = useRef(onDiffReject);
	const onOpenDiffSessionReference = useRef(onOpenDiffSession);
	useEffect(() => {
		onChangeReference.current = onChange;
		onCursorChangeReference.current = onCursorChange;
		onBlurReference.current = onBlur;
		onViewReadyReference.current = onViewReady;
		hunkStatusesReference.current = hunkStatuses;
		hunkSessionReferencesReference.current = hunkSessionReferences;
		onDiffApproveReference.current = onDiffApprove;
		onDiffRejectReference.current = onDiffReject;
		onOpenDiffSessionReference.current = onOpenDiffSession;
	});

	// Create update listener extension — uses refs so it never goes stale
	const createUpdateListener = useCallback(() => {
		return EditorView.updateListener.of((update: ViewUpdate) => {
			if (update.docChanged) {
				if (isApplyingExternalValueReference.current) {
					isApplyingExternalValueReference.current = false;
				} else {
					onChangeReference.current?.(update.state.doc.toString());
				}
			}

			if (update.selectionSet) {
				const head = update.state.selection.main.head;
				const headLine = update.state.doc.lineAt(head);
				const anchor = update.state.selection.main.anchor;
				const anchorLine = update.state.doc.lineAt(anchor);
				onCursorChangeReference.current?.({
					line: headLine.number,
					column: head - headLine.from + 1,
					anchorLine: anchorLine.number,
					anchorColumn: anchor - anchorLine.from + 1,
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
			? buildDiffExtensions(
					diffData,
					hunkStatusesReference.current,
					hunkSessionReferencesReference.current,
					onDiffApproveReference,
					onDiffRejectReference,
					onOpenDiffSessionReference,
				)
			: [];
		const isDark = resolvedTheme === 'dark';

		const lintExtensions = readonly || !projectId ? [] : createLintExtension(projectId, filename);

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
			// Flush unsaved content before the view is destroyed.
			onBlurReference.current?.();
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
			isApplyingExternalValueReference.current = true;
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
		const lintExtensions = readonly || !projectId ? [] : createLintExtension(projectId, filename);
		viewReference.current.dispatch({
			effects: [languageCompartment.reconfigure(langExtension ?? []), lintCompartment.reconfigure(lintExtensions)],
		});
	}, [filename, projectId, readonly, languageCompartment, lintCompartment]);

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
			? buildDiffExtensions(
					diffData,
					hunkStatusesReference.current,
					hunkSessionReferencesReference.current,
					onDiffApproveReference,
					onDiffRejectReference,
					onOpenDiffSessionReference,
				)
			: [];
		viewReference.current.dispatch({
			effects: diffCompartment.reconfigure(diffExtensions),
		});
	}, [diffData, hunkStatuses, hunkSessionReferences, diffCompartment]);

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
