import { EditorView } from '@codemirror/view';
import { Package, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { CodeEditor, DiffFloatingBar, FileTabs, GitDiffToolbar, groupHunksIntoChanges } from '@/features/editor';
import { useCollabCursors } from '@/features/editor/hooks/use-collab-cursors';
import { isLintableFile } from '@/lib/biome-linter';
import { springSnappy } from '@/lib/motion-config';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { isProtectedSystemFile } from '@shared/constants';

const WranglerSettingsPanel = lazy(() =>
	import('@/features/project-settings/wrangler-settings-panel').then((m) => ({ default: m.WranglerSettingsPanel })),
);

import type { useEditorState } from './use-editor-state';

type EditorState = ReturnType<typeof useEditorState>;

interface EditorAreaProperties {
	projectId: string;
	resolvedTheme: 'light' | 'dark';
	editorState: EditorState;
	onSelectFile: (path: string) => void;
	tabsPrefix?: React.ReactNode;
}

export function EditorArea({ projectId, resolvedTheme, editorState, onSelectFile, tabsPrefix }: EditorAreaProperties) {
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

	const closeAllFiles = useStore((state) => state.closeAllFiles);

	// Track whether the active file has fixable lint issues (to show/hide prettify FAB).
	// We store [filePath, hasFixable] so that when activeFile changes the stale value
	// is detected during render and reset without needing setState-in-effect.
	const [fixableState, setFixableState] = useState<[string | undefined, boolean]>([activeFile, false]);
	const hasFixableIssues = fixableState[0] === activeFile && fixableState[1];
	if (fixableState[0] !== activeFile) {
		setFixableState([activeFile, false]);
	}
	useEffect(() => {
		const handler = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const detail: { filePath: string; diagnostics: Array<{ fixable: boolean }> } = event.detail;
			if (detail.filePath === activeFile) {
				setFixableState([activeFile, detail.diagnostics.some((d) => d.fixable)]);
			}
		};
		globalThis.addEventListener('lint-diagnostics', handler);
		return () => globalThis.removeEventListener('lint-diagnostics', handler);
	}, [activeFile]);

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
					onCloseAll={closeAllFiles}
					participants={participants}
					className="min-w-0 flex-1"
				/>
			</div>
			{isGitDiffActive && activeFile && gitDiffView && (
				<GitDiffToolbar path={activeFile} description={gitDiffView.description ?? 'Working Changes'} onClose={clearGitDiff} />
			)}
			<div className="relative flex-1 overflow-hidden">
				{activeFile ? (
					activeFile === '/wrangler.jsonc' ? (
						<Suspense
							fallback={
								<div className="flex h-full items-center justify-center">
									<Spinner size="md" />
								</div>
							}
						>
							<WranglerSettingsPanel projectId={projectId} />
						</Suspense>
					) : isLoadingContent ? (
						<div className="flex h-full items-center justify-center">
							<Spinner size="md" />
						</div>
					) : (
						<>
							{isProtectedSystemFile(activeFile) && <ProtectedFileBanner path={activeFile} />}
							<CodeEditor
								value={
									isGitDiffActive && gitDiffView
										? gitDiffView.afterContent
										: hasActiveDiff && activePendingChange?.afterContent
											? activePendingChange.afterContent
											: editorContent
								}
								filename={activeFile}
								onChange={isGitDiffActive || isProtectedSystemFile(activeFile) ? undefined : handleEditorChange}
								onCursorChange={handleCursorChange}
								onBlur={isGitDiffActive || hasActiveDiff || isProtectedSystemFile(activeFile) ? undefined : handleEditorBlur}
								goToPosition={pendingGoTo}
								onGoToPositionConsumed={clearPendingGoTo}
								readonly={isGitDiffActive || isProtectedSystemFile(activeFile)}
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
							<AnimatePresence>
								{activeFile && !isGitDiffActive && !isProtectedSystemFile(activeFile) && isLintableFile(activeFile) && hasFixableIssues && (
									<motion.div
										initial={{ opacity: 0, scale: 0.8 }}
										animate={{ opacity: 1, scale: 1 }}
										exit={{ opacity: 0, scale: 0.8 }}
										transition={springSnappy}
										className="absolute right-4 bottom-4 z-10"
									>
										<Tooltip content="Prettify (Shift+Alt+F)">
											<motion.button
												type="button"
												whileTap={{ scale: 0.85 }}
												transition={springSnappy}
												onClick={() => void handlePrettify()}
												disabled={isPrettifying}
												className={cn(
													`
														flex size-8 cursor-pointer items-center justify-center
														rounded-full shadow-lg transition-colors
													`,
													`
														border border-border bg-bg-secondary text-text-secondary
														hover:bg-bg-tertiary hover:text-accent
													`,
													'disabled:pointer-events-none disabled:opacity-50',
												)}
												aria-label="Prettify file"
											>
												{isPrettifying ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5" />}
											</motion.button>
										</Tooltip>
									</motion.div>
								)}
							</AnimatePresence>
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
									canReject={changeReview.canReject && !!activePendingChange.reviewId}
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

function ProtectedFileBanner({ path }: { path: string }) {
	const showDependenciesPanel = useStore((state) => state.showDependenciesPanel);
	const isPackageJson = path === '/package.json';

	return (
		<div
			className="
				flex shrink-0 items-center gap-2 border-b border-border bg-bg-secondary px-3
				py-1.5 text-xs text-text-secondary
			"
		>
			<Package className="size-3.5" />
			<span>This file is managed by the IDE and is read-only.</span>
			{isPackageJson && (
				<button
					type="button"
					onClick={showDependenciesPanel}
					className="
						cursor-pointer text-accent underline
						hover:text-accent-hover
					"
				>
					Open Dependencies panel
				</button>
			)}
		</div>
	);
}
