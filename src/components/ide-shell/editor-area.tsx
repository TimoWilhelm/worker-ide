/**
 * Shared editor area component used by both mobile and desktop layouts.
 * Includes file tabs, prettify button, diff toolbars, CodeEditor, and empty state.
 */

import { Loader2, Sparkles } from 'lucide-react';

import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { CodeEditor, DiffToolbar, FileTabs, GitDiffToolbar } from '@/features/editor';
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
			{!isGitDiffActive && hasActiveDiff && activeFile && activePendingChange && (
				<DiffToolbar
					path={activeFile}
					action={activePendingChange.action}
					onApprove={changeReview.handleApproveChange}
					onReject={changeReview.handleRejectChange}
					isReverting={changeReview.isReverting}
					canReject={changeReview.canReject}
				/>
			)}
			<div className="flex-1 overflow-hidden">
				{activeFile ? (
					isLoadingContent ? (
						<div className="flex h-full items-center justify-center">
							<Spinner size="md" />
						</div>
					) : (
						<CodeEditor
							value={
								isGitDiffActive && gitDiffView
									? gitDiffView.afterContent
									: hasActiveDiff && activePendingChange?.afterContent
										? activePendingChange.afterContent
										: editorContent
							}
							filename={activeFile}
							onChange={isGitDiffActive || hasActiveDiff ? undefined : handleEditorChange}
							onCursorChange={handleCursorChange}
							onBlur={isGitDiffActive || hasActiveDiff ? undefined : handleEditorBlur}
							goToPosition={pendingGoTo}
							onGoToPositionConsumed={clearPendingGoTo}
							readonly={isGitDiffActive || hasActiveDiff}
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
							onViewReady={handleViewReady}
						/>
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
