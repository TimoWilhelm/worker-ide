/**
 * Hook for managing remote collaboration cursors in the CodeMirror editor.
 *
 * Creates the CodeMirror extension once and updates remote cursor decorations
 * whenever participants or the active file changes.
 */

import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useStore } from '@/lib/store';

import { createCollabCursorsExtension } from '../lib/collab-cursors-extension';

import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

interface UseCollabCursorsResult {
	/** CodeMirror extension to include in the editor */
	extension: Extension;
	/** Callback to pass to CodeEditor's onViewReady — tracks the current view */
	handleViewReady: (view?: EditorView) => void;
}

export function useCollabCursors(activeFile: string | undefined): UseCollabCursorsResult {
	const { participants, localParticipantId } = useStore(
		useShallow((state) => ({
			participants: state.participants,
			localParticipantId: state.localParticipantId,
		})),
	);

	// Create the extension once via lazy state initializer (safe to read during render)
	const [collabCursors] = useState(createCollabCursorsExtension);
	// Track the EditorView in state so that setting it triggers the effect below
	const [view, setView] = useState<EditorView | undefined>();

	const handleViewReady = useCallback((editorView?: EditorView) => {
		setView(editorView);
	}, []);

	// Update remote cursor decorations when participants, active file, or view changes
	useEffect(() => {
		if (!view) return;

		collabCursors.update(view, participants, activeFile, localParticipantId);
	}, [view, participants, activeFile, localParticipantId, collabCursors]);

	return {
		extension: collabCursors.extension,
		handleViewReady,
	};
}
