/**
 * Hook for persisting and restoring editor session state.
 *
 * Saves open tabs, active file, and per-file scroll positions to localStorage
 * scoped by project ID. Restores the session on mount so the editor picks up
 * where it left off after a page reload.
 *
 * Deleted files are silently filtered out during restore so stale tabs don't
 * appear. Scroll positions for changed (shorter/longer) files are naturally
 * clamped at render time by the editor's `handleViewReady`.
 */

import { useEffect, useRef } from 'react';

import { loadEditorSession, resolveEditorSession, saveEditorSession } from '@/lib/editor-session';
import { useStore } from '@/lib/store';

const SAVE_DEBOUNCE_MS = 500;

/**
 * Persist editor session state (open tabs, active file, scroll positions) to
 * localStorage for the given project, and restore it on mount.
 */
export function useEditorSessionPersistence({ projectId }: { projectId: string }) {
	const hasRestoredReference = useRef(false);

	// Reset restore flag when projectId changes so a new project's session is restored
	useEffect(() => {
		hasRestoredReference.current = false;
	}, [projectId]);

	// ── Restore on mount ──────────────────────────────────────────────
	// Wait until the file list has been loaded so we can filter out
	// tabs whose files no longer exist.
	const files = useStore((state) => state.files);
	const isLoading = useStore((state) => state.isLoading);

	useEffect(() => {
		if (hasRestoredReference.current) return;
		// Wait for the file list to finish loading before restoring
		if (isLoading) return;
		hasRestoredReference.current = true;

		const session = loadEditorSession(projectId);
		const existingPaths = new Set(files.map((file) => file.path));
		const resolved = resolveEditorSession(session, existingPaths);
		if (!resolved) return;

		useStore.setState({
			openFiles: resolved.openFiles,
			activeFile: resolved.activeFile,
			fileScrollPositions: resolved.scrollPositions,
		});
	}, [projectId, files, isLoading]);

	// ── Persist on change (debounced) ─────────────────────────────────
	const saveTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		const unsubscribe = useStore.subscribe((state, previousState) => {
			// Only save when relevant editor state changes
			const changed =
				state.openFiles !== previousState.openFiles ||
				state.activeFile !== previousState.activeFile ||
				state.fileScrollPositions !== previousState.fileScrollPositions;

			if (!changed) return;

			clearTimeout(saveTimeoutReference.current);
			saveTimeoutReference.current = setTimeout(() => {
				const { openFiles, activeFile, fileScrollPositions } = useStore.getState();

				saveEditorSession(projectId, {
					openFiles,
					activeFile,
					scrollPositions: Object.fromEntries(fileScrollPositions),
				});
			}, SAVE_DEBOUNCE_MS);
		});

		return () => {
			unsubscribe();
			// Flush any pending save on unmount
			clearTimeout(saveTimeoutReference.current);
			const { openFiles, activeFile, fileScrollPositions } = useStore.getState();
			saveEditorSession(projectId, {
				openFiles,
				activeFile,
				scrollPositions: Object.fromEntries(fileScrollPositions),
			});
		};
	}, [projectId]);
}
