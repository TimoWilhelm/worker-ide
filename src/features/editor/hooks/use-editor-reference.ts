import { type EditorView } from '@codemirror/view';
import { useCallback, useRef } from 'react';

/**
 * Hook to get editor view reference for external control.
 */
export function useEditorReference() {
	const viewReference = useRef<EditorView | undefined>(undefined);

	const setView = useCallback((view: EditorView | undefined) => {
		viewReference.current = view;
	}, []);

	const getView = useCallback(() => viewReference.current, []);

	return { setView, getView };
}
