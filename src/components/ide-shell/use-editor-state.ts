/**
 * Hook for managing the editor state: file content, diffs, save, prettify, and cursor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useChangeReview } from '@/features/ai-assistant/hooks/use-change-review';
import { computeDiffData, groupHunksIntoChanges, useFileContent } from '@/features/editor';
import { dispatchLintDiagnostics } from '@/features/editor/lib/lint-extension';
import { projectSocketSendReference } from '@/hooks';
import { fixFile, isLintableFile } from '@/lib/biome-linter';
import { selectGitDiffView, selectGitStatus, useStore } from '@/lib/store';

import type { EditorView } from '@codemirror/view';

export function useEditorState({ projectId }: { projectId: string }) {
	const {
		activeFile,
		openFiles,
		unsavedChanges,
		closeFile,
		markFileChanged,
		setCursorPosition,
		goToFilePosition,
		clearPendingGoTo,
		pendingGoTo,
		pendingChanges,
		approveChange,
		participants,
		cursorPosition,
	} = useStore();

	// Git diff view (read-only git diffs in the editor)
	const gitDiffView = useStore(selectGitDiffView);
	const clearGitDiff = useStore((state) => state.clearGitDiff);

	// Git status for file tree coloring
	const gitStatusEntries = useStore(selectGitStatus);
	const gitStatusMap = useMemo(() => {
		const map = new Map<string, import('@shared/types').GitFileStatus>();
		for (const entry of gitStatusEntries) {
			if (entry.status !== 'unmodified') {
				map.set(entry.path, entry.status);
			}
		}
		return map;
	}, [gitStatusEntries]);

	// Change review for diff toolbar
	const changeReview = useChangeReview({ projectId });

	// File content hook
	const { content, isLoading: isLoadingContent, saveFile, isSaving } = useFileContent({ projectId, path: activeFile });

	// Track local editor edits
	const [localEditorContent, setLocalEditorContent] = useState<string>();

	// Reset local edits when server content changes, but only when the
	// query has finished loading. While loading, `content` is '' (the
	// default) which would incorrectly wipe in-progress edits.
	const [previousContent, setPreviousContent] = useState(content);
	if (!isLoadingContent && content !== previousContent) {
		setPreviousContent(content);
		setLocalEditorContent(undefined);
	}

	const editorContent = localEditorContent ?? content ?? '';

	// Compute inline diff data for the active file (if it has a pending AI change).
	const activePendingChange = activeFile ? pendingChanges.get(activeFile) : undefined;
	const hasActiveDiff = activePendingChange?.status === 'pending' && activePendingChange.action !== 'move';

	const activeDiffData = useMemo(() => {
		if (!activeFile) return;
		const pendingChange = pendingChanges.get(activeFile);
		if (!pendingChange || pendingChange.status !== 'pending') return;
		return computeDiffData(pendingChange.beforeContent, pendingChange.afterContent ?? editorContent);
	}, [activeFile, pendingChanges, editorContent]);

	// Lazily initialize per-hunk statuses when a diff is first displayed.
	useEffect(() => {
		if (!activeFile || !activeDiffData || !activePendingChange) return;
		if (activePendingChange.hunkStatuses.length > 0) return; // already initialized

		const changeGroups = groupHunksIntoChanges(activeDiffData.hunks);
		if (changeGroups.length === 0) return;

		const statuses = changeGroups.map(() => 'pending' as const);
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get(activeFile);
			if (change && change.hunkStatuses.length === 0) {
				newMap.set(activeFile, { ...change, hunkStatuses: statuses });
			}
			return { pendingChanges: newMap };
		});
	}, [activeFile, activeDiffData, activePendingChange]);

	// Compute git diff data when a read-only git diff view is active
	const isGitDiffActive = !!gitDiffView && gitDiffView.path === activeFile;
	const gitDiffData = useMemo(() => {
		if (!gitDiffView || gitDiffView.path !== activeFile) return;
		return computeDiffData(gitDiffView.beforeContent, gitDiffView.afterContent);
	}, [gitDiffView, activeFile]);

	// Git diff takes priority over AI diff when both exist for the same file
	const effectiveDiffData = gitDiffData ?? activeDiffData;

	// Build tabs data — add label when git diff is active
	const tabs = openFiles.map((path) => ({
		path,
		hasUnsavedChanges: unsavedChanges.get(path) ?? false,
		isSaving: isSaving && path === activeFile,
		label: gitDiffView?.path === path ? `${path.split('/').pop() ?? path} (${gitDiffView.description ?? 'Working Changes'})` : undefined,
	}));

	// Handle editor content changes
	const handleEditorChange = useCallback(
		(newContent: string) => {
			setLocalEditorContent(newContent);
			if (activeFile && newContent !== content) {
				markFileChanged(activeFile, true);
				// Auto-approve pending AI change when user manually edits the file
				const pending = pendingChanges.get(activeFile);
				if (pending?.status === 'pending') {
					approveChange(activeFile);
				}
			}
		},
		[activeFile, content, markFileChanged, pendingChanges, approveChange],
	);

	// Handle save
	const handleSave = useCallback(async () => {
		if (activeFile && unsavedChanges.get(activeFile)) {
			try {
				await saveFile(editorContent);
				markFileChanged(activeFile, false);
			} catch {
				// Save failed — keep the dirty flag so the user knows
			}
		}
	}, [activeFile, unsavedChanges, saveFile, editorContent, markFileChanged]);

	// Ref to keep handleSave stable
	const handleSaveReference = useRef(handleSave);
	useEffect(() => {
		handleSaveReference.current = handleSave;
	}, [handleSave]);

	// Auto-save when the editor loses focus (onFocusChange, like VS Code)
	const handleEditorBlur = useCallback(() => {
		void handleSaveReference.current();
	}, []);

	// Editor view ref for direct CodeMirror dispatch (preserves scroll position)
	const editorViewReference = useRef<EditorView | undefined>(undefined);
	const handleViewReady = useCallback((view?: EditorView) => {
		editorViewReference.current = view;
	}, []);

	// Prettify: apply all Biome fixes + formatting to the active file
	const [isPrettifying, setIsPrettifying] = useState(false);
	const handlePrettify = useCallback(async () => {
		if (!activeFile || isGitDiffActive) return;
		setIsPrettifying(true);
		try {
			const result = await fixFile(activeFile, editorContent);
			if (!result || result.fixCount === 0) return;

			// Dispatch directly through CodeMirror to preserve scroll position.
			const view = editorViewReference.current;
			if (view) {
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: result.content },
				});
			} else {
				setLocalEditorContent(result.content);
			}

			// Immediately dispatch remaining diagnostics to the output panel
			dispatchLintDiagnostics(activeFile, result.remainingDiagnostics);

			if (activeFile) {
				markFileChanged(activeFile, true);
			}
		} finally {
			setIsPrettifying(false);
		}
	}, [activeFile, editorContent, isGitDiffActive, markFileChanged]);

	// Wrap selectFile from file tree: autosave current file before switching + clear git diff
	const selectFileFromTree = useCallback(
		(path: string) => {
			void handleSaveReference.current();
			if (gitDiffView && gitDiffView.path !== path) {
				clearGitDiff();
			}
		},
		[gitDiffView, clearGitDiff],
	);

	// Wrap closeFile: autosave current file before closing + clear git diff if closing diffed file
	const handleCloseFile = useCallback(
		(path: string) => {
			void handleSaveReference.current();
			if (gitDiffView?.path === path) {
				clearGitDiff();
			}
			closeFile(path);
		},
		[closeFile, gitDiffView, clearGitDiff],
	);

	// Send cursor updates to collaborators (debounced)
	const cursorUpdateTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const handleCursorChange = useCallback(
		(position: { line: number; column: number }) => {
			setCursorPosition(position);

			// Debounce WebSocket cursor update
			clearTimeout(cursorUpdateTimeoutReference.current);
			cursorUpdateTimeoutReference.current = setTimeout(() => {
				projectSocketSendReference.current?.({
					type: 'cursor-update',
					file: activeFile ?? '',
					cursor: { line: position.line, ch: position.column },
					// eslint-disable-next-line unicorn/no-null -- WebSocket wire format uses null
					selection: null,
				});
			}, 100);
		},
		[setCursorPosition, activeFile],
	);

	return {
		// File & content
		activeFile,
		openFiles,
		unsavedChanges,
		participants,
		cursorPosition,
		isLoadingContent,
		isSaving,
		editorContent,
		tabs,

		// Diff state
		gitDiffView,
		clearGitDiff,
		isGitDiffActive,
		hasActiveDiff,
		activePendingChange,
		effectiveDiffData,
		changeReview,

		// Git status
		gitStatusMap,

		// Handlers
		handleEditorChange,
		handleSave,
		handleSaveReference,
		handleEditorBlur,
		handleViewReady,
		handlePrettify,
		isPrettifying,
		handleCloseFile,
		handleCursorChange,
		selectFileFromTree,
		cursorUpdateTimeoutReference,

		// GoTo
		pendingGoTo,
		clearPendingGoTo,
		goToFilePosition,

		// Pending changes (for store access)
		pendingChanges,
		markFileChanged,

		// Linting
		isLintableFile,
	};
}
