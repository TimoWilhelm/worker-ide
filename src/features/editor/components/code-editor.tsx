/**
 * CodeMirror Editor Component
 *
 * React wrapper for CodeMirror 6 with language support and theme.
 */

import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { useCallback, useEffect, useRef } from 'react';

import { createEditorExtensions, createTabSizeExtension, getLanguageExtension, readonlyExtension } from '../lib/extensions';

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
	/** Whether the editor is readonly */
	readonly?: boolean;
	/** Tab size (default: 2) */
	tabSize?: number;
	/** Additional extensions */
	extensions?: Extension[];
	/** CSS class name */
	className?: string;
}

// =============================================================================
// Compartments for dynamic reconfiguration
// =============================================================================

const languageCompartment = new Compartment();
const readonlyCompartment = new Compartment();
const tabSizeCompartment = new Compartment();

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
	readonly = false,
	tabSize = 2,
	extensions: additionalExtensions = [],
	className,
}: CodeEditorProperties) {
	const containerReference = useRef<HTMLDivElement>(null);
	const viewReference = useRef<EditorView | undefined>(undefined);

	// Create update listener extension
	const createUpdateListener = useCallback(() => {
		return EditorView.updateListener.of((update: ViewUpdate) => {
			if (update.docChanged && onChange) {
				onChange(update.state.doc.toString());
			}

			if (update.selectionSet && onCursorChange) {
				const position = update.state.selection.main.head;
				const line = update.state.doc.lineAt(position);
				onCursorChange({
					line: line.number,
					column: position - line.from + 1,
				});
			}
		});
	}, [onChange, onCursorChange]);

	// Initialize editor
	useEffect(() => {
		if (!containerReference.current || viewReference.current) return;

		const langExtension = getLanguageExtension(filename);
		const baseExtensions = createEditorExtensions(filename, [createUpdateListener(), ...additionalExtensions]);

		// Remove language from base extensions since we'll use compartment
		const extensions = [
			...baseExtensions,
			languageCompartment.of(langExtension ?? []),
			readonlyCompartment.of(readonly ? readonlyExtension : []),
			tabSizeCompartment.of(createTabSizeExtension(tabSize)),
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
	}, [filename]);

	// Update readonly state
	useEffect(() => {
		if (!viewReference.current) return;

		viewReference.current.dispatch({
			effects: readonlyCompartment.reconfigure(readonly ? readonlyExtension : []),
		});
	}, [readonly]);

	// Update tab size
	useEffect(() => {
		if (!viewReference.current) return;

		viewReference.current.dispatch({
			effects: tabSizeCompartment.reconfigure(createTabSizeExtension(tabSize)),
		});
	}, [tabSize]);

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
