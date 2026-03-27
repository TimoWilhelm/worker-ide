/**
 * Shared editor area component used by both mobile and desktop layouts.
 * Includes file tabs, prettify button, diff toolbars, CodeEditor, and empty state.
 */

import { EditorView } from '@codemirror/view';
import { Loader2, Sparkles } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { CodeEditor, DiffFloatingBar, FileTabs, GitDiffToolbar, groupHunksIntoChanges } from '@/features/editor';
import { useCollabCursors } from '@/features/editor/hooks/use-collab-cursors';
import { isLintableFile } from '@/lib/biome-linter';
import { cn } from '@/lib/utils';

import type { useEditorState } from './use-editor-state';

type EditorState = ReturnType<typeof useEditorState>;

interface EditorAreaProperties {
	resolvedTheme: 'light' | 'dark';
	editorState: EditorState;
	onSelectFile: (path: string) => void;
	/** Optional element to show before the tabs (e.g. file-tree toggle on mobile) */
	tabsPrefix?: React.ReactNode;
}

export function EditorArea({ resolvedTheme, editorState, onSelectFile, tabsPrefix }: EditorAreaProperties) {
	const {
		activeFile,
		tabs,
		participants,
		isLoadingContent,
		editorContent,
		gitDiffView,
		clearGitDiff,
		isGitDiffActive,
		hasActiveDiff,
		activePendingChange,
		effectiveDiffData,
		changeReview,
		handleEditorChange,
		handleEditorBlur,
		handleViewReady,
		handlePrettify,
		isPrettifying,
		handleCloseFile,
		handleCursorChange,
		pendingGoTo,
		clearPendingGoTo,
	} = editorState;

	// Remote collaboration cursors extension
	const { extension: collabCursorsExtension, handleViewReady: handleCollabViewReady } = useCollabCursors(activeFile);

	// Editor view ref for hunk navigation (scrolling to change groups)
	const editorViewReference = useRef<EditorView | undefined>(undefined);

	// Combine the editor state's view-ready handler with the collab cursors handler
	const combinedHandleViewReady = useCallback(
		(view?: EditorView) => {
			editorViewReference.current = view;
			handleViewReady(view);
			handleCollabViewReady(view);
		},
		[handleViewReady, handleCollabViewReady],
	);

	// Compute change groups from the active diff data for the floating bar
	const changeGroups = useMemo(
		() => (hasActiveDiff && effectiveDiffData ? groupHunksIntoChanges(effectiveDiffData.hunks) : []),
		[hasActiveDiff, effectiveDiffData],
	);

	// Track which change group the user is currently viewing
	const [currentGroupIndex, setCurrentGroupIndex] = useState(0);

	// Reset current index when the file or diff changes
	const previousDiffKeyReference = useRef<string | undefined>(undefined);
	const diffKey = activeFile && hasActiveDiff ? `${activeFile}:${effectiveDiffData?.hunks.length}` : undefined;
	if (diffKey !== previousDiffKeyReference.current) {
		previousDiffKeyReference.current = diffKey;
		if (currentGroupIndex !== 0) {
			setCurrentGroupIndex(0);
		}
	}

	// Clamp index when changeGroups shrinks (e.g. after user edits recompute the diff)
	if (changeGroups.length > 0 && currentGroupIndex >= changeGroups.length) {
		setCurrentGroupIndex(changeGroups.length - 1);
	}

	// Navigate to a change group by scrolling the editor to its start line
	const handleNavigateToGroup = useCallback(
		(groupIndex: number) => {
			setCurrentGroupIndex(groupIndex);
			const view = editorViewReference.current;
			const group = changeGroups[groupIndex];
			if (!view || !group) return;

			const lineNumber = Math.min(group.startLine, view.state.doc.lines);
			const line = view.state.doc.line(lineNumber);
			view.dispatch({
				selection: { anchor: line.from },
				effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
			});
			view.focus();
		},
		[changeGroups],
	);

	return (
		<>
			<div className="flex items-stretch">
				{tabsPrefix}
				<FileTabs
					tabs={tabs}
					activeTab={activeFile}
					onSelect={onSelectFile}
					onClose={handleCloseFile}
					participants={participants}
					className="min-w-0 flex-1"
				/>
				{activeFile && !isGitDiffActive && isLintableFile(activeFile) && (
					<Tooltip content="Prettify (Shift+Alt+F)">
						<button
							type="button"
							onClick={() => void handlePrettify()}
							disabled={isPrettifying}
							className={cn(
								'flex shrink-0 cursor-pointer items-center justify-center px-2',
								`
									border-b border-border bg-bg-secondary text-text-secondary
									transition-colors
								`,
								'hover:bg-bg-tertiary hover:text-accent',
								'disabled:pointer-events-none disabled:opacity-50',
							)}
							aria-label="Prettify file"
						>
							{isPrettifying ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
						</button>
					</Tooltip>
				)}
			</div>
			{isGitDiffActive && activeFile && gitDiffView && (
				<GitDiffToolbar path={activeFile} description={gitDiffView.description ?? 'Working Changes'} onClose={clearGitDiff} />
			)}
			<div className="relative flex-1 overflow-hidden">
				{activeFile ? (
					isLoadingContent ? (
						<div className="flex h-full items-center justify-center">
							<Spinner size="md" />
						</div>
					) : (
						<>
							<CodeEditor
								value={
									isGitDiffActive && gitDiffView
										? gitDiffView.afterContent
										: hasActiveDiff && activePendingChange?.afterContent
											? activePendingChange.afterContent
											: editorContent
								}
								filename={activeFile}
								onChange={isGitDiffActive ? undefined : handleEditorChange}
								onCursorChange={handleCursorChange}
								onBlur={isGitDiffActive || hasActiveDiff ? undefined : handleEditorBlur}
								goToPosition={pendingGoTo}
								onGoToPositionConsumed={clearPendingGoTo}
								readonly={isGitDiffActive}
								diffData={effectiveDiffData}
								hunkStatuses={hasActiveDiff ? activePendingChange?.hunkStatuses : undefined}
								onDiffApprove={
									hasActiveDiff && activeFile && !isGitDiffActive
										? (groupIndex: number) => changeReview.handleApproveHunk(activeFile, groupIndex)
										: undefined
								}
								onDiffReject={
									hasActiveDiff && activeFile && !isGitDiffActive
										? (groupIndex: number) => changeReview.handleRejectHunk(activeFile, groupIndex)
										: undefined
								}
								resolvedTheme={resolvedTheme}
								extensions={[collabCursorsExtension]}
								onViewReady={combinedHandleViewReady}
							/>
							{!isGitDiffActive && hasActiveDiff && activeFile && activePendingChange && (
								<DiffFloatingBar
									changeGroups={changeGroups}
									hunkStatuses={activePendingChange.hunkStatuses}
									currentGroupIndex={currentGroupIndex}
									onNavigate={handleNavigateToGroup}
									onAcceptAll={changeReview.handleApproveChange}
									onRejectAll={changeReview.handleRejectChange}
									path={activeFile}
									isReverting={changeReview.isReverting}
									canReject={changeReview.canReject}
								/>
							)}
						</>
					)
				) : (
					<div className="flex h-full items-center justify-center text-text-secondary">
						<p>Select a file to edit</p>
					</div>
				)}
			</div>
		</>
	);
}
