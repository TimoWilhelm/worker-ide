/**
 * IDE Shell Component
 *
 * Main IDE layout with resizable panels: file tree, editor, terminal, preview, and AI assistant.
 */

import { Bot, ChevronUp, Clock, Download, FolderOpen, Github, Hexagon, Moon, Pencil, Plus, Sparkles, Sun, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group as PanelGroup, Panel, Separator as ResizeHandle, useDefaultLayout } from 'react-resizable-panels';

import { ActivityBar } from '@/components/activity-bar';
import { MobileFileDrawer } from '@/components/mobile-file-drawer';
import { MobileTabBar } from '@/components/mobile-tab-bar';
import { BorderBeam } from '@/components/ui/border-beam';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Pill } from '@/components/ui/pill';
import { PanelSkeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { useChangeReview } from '@/features/ai-assistant/hooks/use-change-review';
import { CodeEditor, computeDiffData, DiffToolbar, FileTabs, GitDiffToolbar, useFileContent } from '@/features/editor';
import { dispatchLintDiagnostics } from '@/features/editor/lib/lint-extension';
import { DependencyPanel, FileTree, useFileTree } from '@/features/file-tree';
import { getDependencyErrorCount, subscribeDependencyErrors } from '@/features/file-tree/dependency-error-store';
import { GitPanel } from '@/features/git';
import { useLogs } from '@/features/output/lib/log-buffer';
import { projectSocketSendReference, useIsMobile, useProjectSocket, useTheme } from '@/hooks';
import { downloadProject, fetchProjectMeta, updateProjectMeta } from '@/lib/api-client';
import { fixFile, isLintableFile } from '@/lib/biome-linter';
import { getRecentProjects, removeProject, trackProject, type RecentProject } from '@/lib/recent-projects';
import { selectGitDiffView, selectGitStatus, selectIsProcessing, useStore } from '@/lib/store';
import { cn, formatRelativeTime } from '@/lib/utils';

import type { LogCounts } from '@/features/output';
import type { EditorView } from '@codemirror/view';

// Lazy-loaded feature panels for code splitting
const AIPanel = lazy(() => import('@/features/ai-assistant'));
const DevelopmentToolsPanel = lazy(() => import('@/features/devtools'));
const PreviewPanel = lazy(() => import('@/features/preview'));
const UtilityPanel = lazy(() => import('@/features/utility-panel'));

// =============================================================================
// IDE Shell
// =============================================================================

export function IDEShell({ projectId }: { projectId: string }) {
	// Project WebSocket connection (HMR notifications, collaboration, server events)
	useProjectSocket({ projectId });

	// Theme
	const resolvedTheme = useTheme();
	const setColorScheme = useStore((state) => state.setColorScheme);

	// Auto-expand dependencies panel when new errors are detected.
	// Uses a Zustand store subscription (external system) so setState is called
	// from the subscription callback rather than synchronously inside an effect.
	const showDependenciesPanel = useStore((state) => state.showDependenciesPanel);
	const previousDependencyErrorCount = useRef(0);
	useEffect(() => {
		return subscribeDependencyErrors(() => {
			const currentCount = getDependencyErrorCount();
			if (currentCount > previousDependencyErrorCount.current) {
				showDependenciesPanel();
			}
			previousDependencyErrorCount.current = currentCount;
		});
	}, [showDependenciesPanel]);

	// Mobile layout
	const isMobile = useIsMobile();
	const activeMobilePanel = useStore((state) => state.activeMobilePanel);
	const activeSidebarView = useStore((state) => state.activeSidebarView);
	const mobileFileTreeOpen = useStore((state) => state.mobileFileTreeOpen);
	const toggleMobileFileTree = useStore((state) => state.toggleMobileFileTree);

	// Store state
	const {
		utilityPanelVisible,
		toggleUtilityPanel,
		aiPanelVisible,
		toggleAIPanel,
		devtoolsVisible,
		dependenciesPanelVisible,
		toggleDependenciesPanel,
		activeFile,
		openFiles,
		unsavedChanges,
		closeFile,
		markFileChanged,
		setCursorPosition,
		goToFilePosition,
		clearPendingGoTo,
		pendingGoTo,
		isConnected,
		localParticipantColor,
		participants,
		cursorPosition,
		pendingChanges,
		approveChange,
	} = useStore();

	// Read AI processing state via a dedicated selector to limit re-renders
	const isAiProcessing = useStore(selectIsProcessing);

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

	// Project name state
	const [projectName, setProjectName] = useState<string | undefined>();
	const [isEditingName, setIsEditingName] = useState(false);
	const [editNameValue, setEditNameValue] = useState('');
	const nameInputReference = useRef<HTMLInputElement>(null);

	// Fetch project meta on mount
	useEffect(() => {
		void (async () => {
			try {
				const meta = await fetchProjectMeta(projectId);
				setProjectName(meta.name);
				trackProject(projectId, meta.name);
			} catch {
				// Project meta not available, use fallback
			}
		})();
	}, [projectId]);

	// Focus name input when editing starts
	useEffect(() => {
		if (isEditingName) {
			nameInputReference.current?.focus();
			nameInputReference.current?.select();
		}
	}, [isEditingName]);

	const handleStartRename = useCallback(() => {
		setEditNameValue(projectName ?? '');
		setIsEditingName(true);
	}, [projectName]);

	const handleSaveRename = useCallback(async () => {
		const trimmed = editNameValue.trim();
		if (trimmed && trimmed !== projectName) {
			const previousName = projectName;
			setProjectName(trimmed);
			trackProject(projectId, trimmed);
			try {
				await updateProjectMeta(projectId, trimmed);
			} catch {
				setProjectName(previousName);
				toast.error('Failed to rename project');
			}
		}
		setIsEditingName(false);
	}, [editNameValue, projectName, projectId]);

	const handleCancelRename = useCallback(() => {
		setIsEditingName(false);
	}, []);

	// Terminal log counts — derived from the global log buffer
	const logs = useLogs();
	const logCounts = useMemo<LogCounts>(() => {
		let errors = 0;
		let warnings = 0;
		let logCount = 0;
		for (const entry of logs) {
			if (entry.level === 'error') errors++;
			else if (entry.level === 'warning') warnings++;
			else logCount++;
		}
		return { errors, warnings, logs: logCount };
	}, [logs]);

	// Auto-open utility panel when errors arrive
	const previousErrorCount = useRef(0);
	useEffect(() => {
		if (logCounts.errors > previousErrorCount.current && !utilityPanelVisible) {
			toggleUtilityPanel();
		}
		previousErrorCount.current = logCounts.errors;
	}, [logCounts.errors, utilityPanelVisible, toggleUtilityPanel]);

	// Shared preview iframe ref for CDP message relay with DevTools
	const previewIframeReference = useRef<HTMLIFrameElement>(null);

	// File tree hook
	const {
		files,
		selectedFile,
		expandedDirectories,
		selectFile,
		toggleDirectory,
		isLoading: isLoadingFiles,
		createFile,
		deleteFile,
		renameFile,
		createFolder,
	} = useFileTree({ projectId });

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
	// Uses the stored afterContent so decorations accurately reflect the AI's
	// proposed change, falling back to editorContent if afterContent is unavailable.
	const activePendingChange = activeFile ? pendingChanges.get(activeFile) : undefined;
	const hasActiveDiff = activePendingChange?.status === 'pending' && activePendingChange.action !== 'move';

	const activeDiffData = useMemo(() => {
		if (!activeFile) return;
		const pendingChange = pendingChanges.get(activeFile);
		if (!pendingChange || pendingChange.status !== 'pending') return;
		return computeDiffData(pendingChange.beforeContent, pendingChange.afterContent ?? editorContent);
	}, [activeFile, pendingChanges, editorContent]);

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
	const handlePrettify = useCallback(async () => {
		if (!activeFile || isGitDiffActive) return;
		const result = await fixFile(activeFile, editorContent);
		if (!result || result.fixCount === 0) return;

		// Dispatch directly through CodeMirror to preserve scroll position.
		// The onChange callback fires automatically to sync React state.
		const view = editorViewReference.current;
		if (view) {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: result.content },
			});
		} else {
			setLocalEditorContent(result.content);
		}

		// Immediately dispatch remaining diagnostics to the output panel so that
		// lint errors are visible right away instead of waiting for the CodeMirror
		// linter to re-run after its 400ms delay.
		dispatchLintDiagnostics(activeFile, result.remainingDiagnostics);

		if (activeFile) {
			markFileChanged(activeFile, true);
		}
	}, [activeFile, editorContent, isGitDiffActive, markFileChanged]);

	// Wrap selectFile: autosave current file before switching + clear git diff if switching away
	const handleSelectFile = useCallback(
		(path: string) => {
			void handleSaveReference.current();
			// Clear git diff view when navigating away from the diffed file
			if (gitDiffView && gitDiffView.path !== path) {
				clearGitDiff();
			}
			selectFile(path);
		},
		[selectFile, gitDiffView, clearGitDiff],
	);

	// Mobile: select file and close the drawer
	const handleMobileSelectFile = useCallback(
		(path: string) => {
			handleSelectFile(path);
			if (mobileFileTreeOpen) {
				toggleMobileFileTree();
			}
		},
		[handleSelectFile, mobileFileTreeOpen, toggleMobileFileTree],
	);

	// Wrap closeFile: autosave current file before closing + clear git diff if closing diffed file
	const handleCloseFile = useCallback(
		(path: string) => {
			void handleSaveReference.current();
			// Clear git diff view when closing the diffed file
			if (gitDiffView?.path === path) {
				clearGitDiff();
			}
			closeFile(path);
		},
		[closeFile, gitDiffView, clearGitDiff],
	);

	// Handle download
	const handleDownload = useCallback(async () => {
		try {
			const blob = await downloadProject(projectId);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${projectName ?? `project-${projectId.slice(0, 8)}`}.zip`;
			document.body.append(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error('Failed to download project:', error);
		}
	}, [projectId, projectName]);

	// Handle file creation
	const handleCreateFile = useCallback(
		(path: string) => {
			createFile({ path, content: '' });
		},
		[createFile],
	);

	// Handle file rename
	const handleRenameFile = useCallback(
		(fromPath: string, toPath: string) => {
			renameFile({ fromPath, toPath });
		},
		[renameFile],
	);

	// Handle folder creation
	const handleCreateFolder = useCallback(
		(path: string) => {
			createFolder(path);
		},
		[createFolder],
	);

	// Handle file move (drag-and-drop)
	const handleMoveFile = useCallback(
		(fromPath: string, toPath: string) => {
			renameFile({ fromPath, toPath });
		},
		[renameFile],
	);

	// Navigate to landing page to create a new project
	const handleNewProject = useCallback(() => {
		globalThis.location.href = '/';
	}, []);

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

	// Listen for __open-file messages from the preview iframe (error overlay)
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.origin !== globalThis.location.origin) return;
			if (event.data?.type === '__open-file' && typeof event.data.file === 'string') {
				const file: string = event.data.file.startsWith('/') ? event.data.file : `/${event.data.file}`;
				const line = typeof event.data.line === 'number' ? event.data.line : 1;
				const column = typeof event.data.column === 'number' ? event.data.column : 1;
				goToFilePosition(file, { line, column });
			}
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [goToFilePosition]);

	// Set a known window name so full-screen preview can focus this tab via window.open()
	useEffect(() => {
		window.name = `worker-ide:${projectId}`;
	}, [projectId]);

	// Listen for __open-file via BroadcastChannel (full-screen preview in another tab)
	useEffect(() => {
		const channelName = `worker-ide:${projectId}`;
		const broadcastChannel = new BroadcastChannel(channelName);

		const handleBroadcast = (event: MessageEvent) => {
			if (event.data?.type === '__open-file' && typeof event.data.file === 'string') {
				const file: string = event.data.file.startsWith('/') ? event.data.file : `/${event.data.file}`;
				const line = typeof event.data.line === 'number' ? event.data.line : 1;
				const column = typeof event.data.column === 'number' ? event.data.column : 1;
				goToFilePosition(file, { line, column });
				broadcastChannel.postMessage({ type: '__open-file-ack' });
			}
		};

		broadcastChannel.addEventListener('message', handleBroadcast);

		return () => {
			broadcastChannel.removeEventListener('message', handleBroadcast);
			broadcastChannel.close();
		};
	}, [projectId, goToFilePosition]);

	// Handle #goto=<file>:<line>:<col> hash when IDE tab is opened from full-screen preview
	useEffect(() => {
		const hash = globalThis.location.hash;
		if (!hash.startsWith('#goto=')) return;

		const gotoValue = hash.slice('#goto='.length);
		const match = gotoValue.match(/^(.+):(\d+):(\d+)$/);
		if (!match) return;

		const file = decodeURIComponent(match[1]);
		const line = Number(match[2]);
		const column = Number(match[3]);
		goToFilePosition(file, { line, column });

		// Clear the hash so it doesn't re-trigger on HMR or navigation
		history.replaceState(undefined, '', globalThis.location.pathname + globalThis.location.search);
	}, [goToFilePosition]);

	// Forward bundle errors to the preview iframe so the error overlay shows
	useEffect(() => {
		const handleServerError = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const error = event.detail;
			if (error?.type !== 'bundle') return;
			previewIframeReference.current?.contentWindow?.postMessage({ type: '__show-error-overlay', error }, globalThis.location.origin);
		};

		globalThis.addEventListener('server-error', handleServerError);
		return () => globalThis.removeEventListener('server-error', handleServerError);
	}, []);

	// Clean up cursor debounce timeout on unmount
	useEffect(() => {
		return () => {
			clearTimeout(cursorUpdateTimeoutReference.current);
		};
	}, []);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key === 's') {
				event.preventDefault();
				void handleSaveReference.current();
			}
		};

		globalThis.addEventListener('keydown', handleKeyDown);
		return () => globalThis.removeEventListener('keydown', handleKeyDown);
	}, []);

	// =========================================================================
	// Persist panel layouts to localStorage via react-resizable-panels
	// =========================================================================

	// Main horizontal layout: sidebar | editor-col | preview-col | ai-panel
	const mainPanelIds = useMemo(() => {
		const ids = ['sidebar', 'editor-col', 'preview-col'];
		if (aiPanelVisible) ids.push('ai-panel');
		return ids;
	}, [aiPanelVisible]);

	const mainLayout = useDefaultLayout({ id: 'ide-main', panelIds: mainPanelIds });

	// Sidebar panels: file-tree | dependencies
	const sidebarPanelIds = useMemo(() => {
		const ids = ['file-tree'];
		if (dependenciesPanelVisible) ids.push('dependencies');
		return ids;
	}, [dependenciesPanelVisible]);

	const sidebarLayout = useDefaultLayout({ id: 'sidebar-panels', panelIds: sidebarPanelIds });

	// Editor + terminal: editor | utility-panel
	const editorTerminalPanelIds = useMemo(() => {
		const ids = ['editor'];
		if (utilityPanelVisible) ids.push('utility-panel');
		return ids;
	}, [utilityPanelVisible]);

	const editorTerminalLayout = useDefaultLayout({ id: 'ide-editor-terminal', panelIds: editorTerminalPanelIds });

	// Preview + devtools: preview | devtools
	const previewDevtoolsPanelIds = useMemo(() => {
		const ids = ['preview'];
		if (devtoolsVisible) ids.push('devtools');
		return ids;
	}, [devtoolsVisible]);

	const previewDevtoolsLayout = useDefaultLayout({ id: 'ide-preview-devtools', panelIds: previewDevtoolsPanelIds });

	return (
		<TooltipProvider>
			<div className="flex h-dvh flex-col overflow-hidden bg-bg-primary">
				{/* Header */}
				<header
					className="
						flex h-10 shrink-0 items-center justify-between border-b border-border
						bg-bg-secondary px-3
					"
				>
					<div className="flex items-center gap-2">
						<Tooltip content="Back to home">
							<a href="/" className="text-accent transition-colors hover:text-accent-hover" aria-label="Back to home">
								<Hexagon className="size-4" />
							</a>
						</Tooltip>
						{isEditingName ? (
							<div className="flex items-center gap-1">
								<input
									ref={nameInputReference}
									value={editNameValue}
									onChange={(event) => setEditNameValue(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === 'Enter') void handleSaveRename();
										if (event.key === 'Escape') handleCancelRename();
									}}
									onBlur={() => void handleSaveRename()}
									className="
										h-6 w-40 rounded-sm border border-accent bg-bg-primary px-1.5 text-sm
										text-text-primary
										focus:outline-none
									"
									maxLength={60}
								/>
							</div>
						) : (
							<div className="group flex items-center gap-1.5">
								<h1 className="font-semibold text-text-primary">{projectName ?? 'Worker IDE'}</h1>
								<Tooltip content="Rename project">
									<button
										onClick={handleStartRename}
										className="
											cursor-pointer text-text-secondary opacity-0 transition-opacity
											hover-always:text-accent
											group-hover-always:opacity-100
										"
										aria-label="Rename project"
									>
										<Pencil className="size-3" />
									</button>
								</Tooltip>
							</div>
						)}
					</div>
					<div className="flex items-center gap-2">
						{/* Save indicator */}
						{isSaving && <span className="text-xs text-text-secondary">Saving...</span>}

						{/* Recent projects */}
						<RecentProjectsDropdown currentProjectId={projectId} onNewProject={handleNewProject} />

						{/* AI toggle (desktop only — mobile uses bottom tab bar) */}
						{!isMobile && (
							<Tooltip content="Toggle Agent panel">
								<div className="relative">
									<Button
										variant="ghost"
										size="icon"
										aria-label="Toggle Agent panel"
										onClick={toggleAIPanel}
										className={cn(aiPanelVisible && 'text-accent')}
									>
										<Bot className="size-4" />
									</Button>
									{isAiProcessing && !aiPanelVisible && <BorderBeam duration={1.5} />}
								</div>
							</Tooltip>
						)}

						{/* Theme toggle */}
						<Tooltip content={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
							<Button
								variant="ghost"
								size="icon"
								aria-label="Toggle color theme"
								onClick={() => setColorScheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
							>
								{resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
							</Button>
						</Tooltip>

						{/* Download */}
						<Tooltip content="Download project">
							<Button variant="ghost" size="icon" aria-label="Download project" onClick={handleDownload}>
								<Download className="size-4" />
							</Button>
						</Tooltip>
					</div>
				</header>

				{/* Mobile layout — stacked panels with bottom tab bar */}
				{isMobile ? (
					<>
						{/* Mobile content area — one panel at a time */}
						<div className="min-h-0 flex-1 overflow-hidden">
							{/* Editor view */}
							{activeMobilePanel === 'editor' && (
								<div className="flex h-full flex-col overflow-hidden">
									<div className="flex shrink-0 items-stretch">
										<button
											type="button"
											onClick={toggleMobileFileTree}
											className={cn(
												'flex w-9 shrink-0 cursor-pointer items-center justify-center',
												`
													border-r border-b border-border bg-bg-secondary text-text-secondary
													transition-colors
												`,
												'hover:bg-bg-tertiary hover:text-text-primary',
											)}
											aria-label="Open file tree"
										>
											<FolderOpen className="size-4" />
										</button>
										<FileTabs
											tabs={tabs}
											activeTab={activeFile}
											onSelect={handleSelectFile}
											onClose={handleCloseFile}
											participants={participants}
											className="min-w-0 flex-1"
										/>
										{activeFile && !isGitDiffActive && isLintableFile(activeFile) && (
											<Tooltip content="Prettify (Shift+Alt+F)">
												<button
													type="button"
													onClick={() => void handlePrettify()}
													className={cn(
														'flex shrink-0 cursor-pointer items-center justify-center px-2',
														`
															border-b border-border bg-bg-secondary text-text-secondary
															transition-colors
														`,
														'hover:bg-bg-tertiary hover:text-accent',
													)}
													aria-label="Prettify file"
												>
													<Sparkles className="size-3.5" />
												</button>
											</Tooltip>
										)}
									</div>
									{isGitDiffActive && activeFile && (
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
													value={isGitDiffActive ? gitDiffView.afterContent : editorContent}
													filename={activeFile}
													onChange={isGitDiffActive ? undefined : handleEditorChange}
													onCursorChange={handleCursorChange}
													onBlur={isGitDiffActive ? undefined : handleEditorBlur}
													goToPosition={pendingGoTo}
													onGoToPositionConsumed={clearPendingGoTo}
													readonly={isGitDiffActive}
													diffData={effectiveDiffData}
													onDiffApprove={
														hasActiveDiff && activeFile && !isGitDiffActive ? () => changeReview.handleApproveChange(activeFile) : undefined
													}
													onDiffReject={
														hasActiveDiff && activeFile && !isGitDiffActive ? () => changeReview.handleRejectChange(activeFile) : undefined
													}
													resolvedTheme={resolvedTheme}
													onViewReady={handleViewReady}
												/>
											)
										) : (
											<div
												className="
													flex h-full items-center justify-center text-text-secondary
												"
											>
												<p>Select a file to edit</p>
											</div>
										)}
									</div>
									{/* Utility panel toggle bar */}
									{utilityPanelVisible ? (
										<div className="flex h-48 shrink-0 flex-col border-t border-border">
											<Suspense fallback={<PanelSkeleton label="Loading output..." />}>
												<UtilityPanel projectId={projectId} onToggle={toggleUtilityPanel} logCounts={logCounts} className="h-full" />
											</Suspense>
										</div>
									) : (
										<button
											type="button"
											onClick={toggleUtilityPanel}
											className={cn(
												'flex h-7 w-full shrink-0 cursor-pointer items-center',
												'border-t border-border bg-bg-secondary px-2 transition-colors',
												'hover:bg-bg-tertiary',
											)}
											aria-label="Show output"
										>
											<div className="flex items-center gap-2">
												<ChevronUp className="size-3 text-text-secondary" />
												<span className="text-xs font-medium text-text-secondary">Output</span>
												{logCounts.errors > 0 && <Pill color="red">{logCounts.errors}</Pill>}
												{logCounts.warnings > 0 && <Pill color="yellow">{logCounts.warnings}</Pill>}
											</div>
										</button>
									)}
								</div>
							)}

							{/* Preview view — always mounted so chobitsu stays alive for CDP commands */}
							<div className={cn('flex h-full flex-col overflow-hidden', activeMobilePanel !== 'preview' && 'hidden')}>
								<div className={cn('overflow-hidden', devtoolsVisible ? 'h-1/2' : 'flex-1')}>
									<Suspense fallback={<PanelSkeleton label="Loading preview..." />}>
										<PreviewPanel projectId={projectId} iframeReference={previewIframeReference} className="h-full" />
									</Suspense>
								</div>
								{devtoolsVisible && (
									<div className="h-1/2 border-t border-border">
										<Suspense fallback={<PanelSkeleton label="Loading DevTools..." />}>
											<DevelopmentToolsPanel previewIframeReference={previewIframeReference} className="h-full" />
										</Suspense>
									</div>
								)}
							</div>

							{/* Git view */}
							{activeMobilePanel === 'git' && <GitPanel projectId={projectId} className="h-full" />}

							{/* Agent view */}
							{activeMobilePanel === 'agent' && (
								<Suspense fallback={<PanelSkeleton label="Loading AI assistant..." />}>
									<AIPanel projectId={projectId} className="h-full" />
								</Suspense>
							)}
						</div>

						{/* Bottom tab bar */}
						<MobileTabBar />

						{/* File tree drawer */}
						<MobileFileDrawer>
							{isLoadingFiles ? (
								<div className="flex flex-1 items-center justify-center">
									<Spinner size="sm" />
								</div>
							) : (
								<FileTree
									participants={participants}
									files={files}
									selectedFile={selectedFile}
									expandedDirectories={expandedDirectories}
									onFileSelect={handleMobileSelectFile}
									onDirectoryToggle={toggleDirectory}
									onCreateFile={handleCreateFile}
									onDeleteFile={deleteFile}
									onRenameFile={handleRenameFile}
									onCreateFolder={handleCreateFolder}
									onMoveFile={handleMoveFile}
									gitStatusMap={gitStatusMap}
									className="flex-1"
								/>
							)}
							<div className="max-h-[40%] shrink-0 overflow-auto border-t border-border">
								<DependencyPanel projectId={projectId} />
							</div>
						</MobileFileDrawer>
					</>
				) : (
					<>
						{/* Desktop layout — fully resizable panel layout */}
						<PanelGroup
							orientation="horizontal"
							id="ide-main"
							className="min-h-0 flex-1"
							defaultLayout={mainLayout.defaultLayout}
							onLayoutChanged={mainLayout.onLayoutChanged}
						>
							{/* Activity Bar + Sidebar */}
							<Panel id="sidebar" defaultSize="15%" minSize="180px" maxSize="25%">
								<div className="flex h-full">
									<ActivityBar />
									<aside
										className="
											flex min-w-0 flex-1 flex-col border-r border-border bg-bg-secondary
										"
									>
										{activeSidebarView === 'explorer' ? (
											<>
												<PanelGroup
													orientation="vertical"
													id="sidebar-panels"
													className="flex-1"
													defaultLayout={sidebarLayout.defaultLayout}
													onLayoutChanged={sidebarLayout.onLayoutChanged}
												>
													<Panel id="file-tree" defaultSize={dependenciesPanelVisible ? '70%' : '100%'} minSize="20%">
														<div className="flex h-full flex-col overflow-hidden">
															{isLoadingFiles ? (
																<div className="flex flex-1 items-center justify-center p-4">
																	<Spinner size="sm" />
																</div>
															) : (
																<FileTree
																	participants={participants}
																	files={files}
																	selectedFile={selectedFile}
																	expandedDirectories={expandedDirectories}
																	onFileSelect={handleSelectFile}
																	onDirectoryToggle={toggleDirectory}
																	onCreateFile={handleCreateFile}
																	onDeleteFile={deleteFile}
																	onRenameFile={handleRenameFile}
																	onCreateFolder={handleCreateFolder}
																	onMoveFile={handleMoveFile}
																	gitStatusMap={gitStatusMap}
																/>
															)}
														</div>
													</Panel>
													{dependenciesPanelVisible && (
														<>
															<ResizeHandle
																className="
																	h-0.5 bg-border transition-colors
																	hover:bg-accent
																	data-[separator=active]:bg-accent
																	data-[separator=hover]:bg-accent
																"
															/>
															<Panel id="dependencies" defaultSize="30%" minSize="10%" maxSize="60%">
																<div className="h-full overflow-auto">
																	<DependencyPanel projectId={projectId} onToggle={toggleDependenciesPanel} />
																</div>
															</Panel>
														</>
													)}
												</PanelGroup>
												{!dependenciesPanelVisible && (
													<DependencyPanel projectId={projectId} collapsed onToggle={toggleDependenciesPanel} />
												)}
											</>
										) : (
											<GitPanel projectId={projectId} className="flex-1" />
										)}
									</aside>
								</div>
							</Panel>

							<ResizeHandle
								className="
									w-0.5 bg-border transition-colors
									hover:bg-accent
									data-[separator=active]:bg-accent
									data-[separator=hover]:bg-accent
								"
							/>

							{/* Editor + Terminal column */}
							<Panel id="editor-col" defaultSize="45%" minSize="20%">
								<div className="flex h-full flex-col overflow-hidden">
									<PanelGroup
										orientation="vertical"
										id="ide-editor-terminal"
										className="flex-1"
										defaultLayout={editorTerminalLayout.defaultLayout}
										onLayoutChanged={editorTerminalLayout.onLayoutChanged}
									>
										{/* Editor area */}
										<Panel id="editor" defaultSize={utilityPanelVisible ? '70%' : '100%'} minSize="30%">
											<div className="flex h-full flex-col overflow-hidden">
												<div className="flex items-stretch">
													<FileTabs
														tabs={tabs}
														activeTab={activeFile}
														onSelect={handleSelectFile}
														onClose={handleCloseFile}
														participants={participants}
														className="min-w-0 flex-1"
													/>
													{activeFile && !isGitDiffActive && isLintableFile(activeFile) && (
														<Tooltip content="Prettify (Shift+Alt+F)">
															<button
																type="button"
																onClick={() => void handlePrettify()}
																className={cn(
																	'flex shrink-0 cursor-pointer items-center justify-center px-2',
																	`
																		border-b border-border bg-bg-secondary text-text-secondary
																		transition-colors
																	`,
																	'hover:bg-bg-tertiary hover:text-accent',
																)}
																aria-label="Prettify file"
															>
																<Sparkles className="size-3.5" />
															</button>
														</Tooltip>
													)}
												</div>
												{isGitDiffActive && activeFile && (
													<GitDiffToolbar
														path={activeFile}
														description={gitDiffView.description ?? 'Working Changes'}
														onClose={clearGitDiff}
													/>
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
																value={isGitDiffActive ? gitDiffView.afterContent : editorContent}
																filename={activeFile}
																onChange={isGitDiffActive ? undefined : handleEditorChange}
																onCursorChange={handleCursorChange}
																onBlur={isGitDiffActive ? undefined : handleEditorBlur}
																goToPosition={pendingGoTo}
																onGoToPositionConsumed={clearPendingGoTo}
																readonly={isGitDiffActive}
																diffData={effectiveDiffData}
																onDiffApprove={
																	hasActiveDiff && activeFile && !isGitDiffActive
																		? () => changeReview.handleApproveChange(activeFile)
																		: undefined
																}
																onDiffReject={
																	hasActiveDiff && activeFile && !isGitDiffActive
																		? () => changeReview.handleRejectChange(activeFile)
																		: undefined
																}
																resolvedTheme={resolvedTheme}
																onViewReady={handleViewReady}
															/>
														)
													) : (
														<div
															className="
																flex h-full items-center justify-center text-text-secondary
															"
														>
															<p>Select a file to edit</p>
														</div>
													)}
												</div>
											</div>
										</Panel>

										{/* Utility panel (resizable) */}
										{utilityPanelVisible && (
											<>
												<ResizeHandle
													className="
														h-0.5 bg-border transition-colors
														hover:bg-accent
														data-[separator=active]:bg-accent
														data-[separator=hover]:bg-accent
													"
												/>
												<Panel id="utility-panel" defaultSize="30%" minSize="10%" maxSize="60%">
													<Suspense fallback={<PanelSkeleton label="Loading output..." />}>
														<UtilityPanel
															projectId={projectId}
															onToggle={toggleUtilityPanel}
															logCounts={logCounts}
															headerRight={
																<div className="flex items-center gap-3 text-xs text-text-secondary">
																	{activeFile && <span className="truncate">{activeFile}</span>}
																	{cursorPosition && (
																		<span>
																			Ln {cursorPosition.line}, Col {cursorPosition.column}
																		</span>
																	)}
																</div>
															}
															className="h-full"
														/>
													</Suspense>
												</Panel>
											</>
										)}
									</PanelGroup>

									{/* Utility panel toggle bar when panel is hidden */}
									{!utilityPanelVisible && (
										<button
											type="button"
											onClick={toggleUtilityPanel}
											className={cn(
												'flex h-7 w-full shrink-0 cursor-pointer items-center',
												'border-t border-border bg-bg-secondary px-2 transition-colors',
												'hover:bg-bg-tertiary',
											)}
											aria-label="Show output"
										>
											<div className="flex items-center gap-2">
												<ChevronUp className="size-3 text-text-secondary" />
												<span className="text-xs font-medium text-text-secondary">Output</span>
												{logCounts.errors > 0 && <Pill color="red">{logCounts.errors}</Pill>}
												{logCounts.warnings > 0 && <Pill color="yellow">{logCounts.warnings}</Pill>}
											</div>
											<div
												className="
													ml-auto flex items-center gap-3 text-xs text-text-secondary
												"
											>
												{activeFile && <span className="truncate">{activeFile}</span>}
												{cursorPosition && (
													<span>
														Ln {cursorPosition.line}, Col {cursorPosition.column}
													</span>
												)}
											</div>
										</button>
									)}
								</div>
							</Panel>

							<ResizeHandle
								className="
									w-0.5 bg-border transition-colors
									hover:bg-accent
									data-[separator=active]:bg-accent
									data-[separator=hover]:bg-accent
								"
							/>

							{/* Preview + DevTools column */}
							<Panel id="preview-col" defaultSize={aiPanelVisible ? '20%' : '40%'} minSize="15%">
								<PanelGroup
									orientation="vertical"
									id="ide-preview-devtools"
									defaultLayout={previewDevtoolsLayout.defaultLayout}
									onLayoutChanged={previewDevtoolsLayout.onLayoutChanged}
								>
									{/* Preview panel */}
									<Panel id="preview" defaultSize={devtoolsVisible ? '70%' : '100%'} minSize="20%">
										<Suspense fallback={<PanelSkeleton label="Loading preview..." />}>
											<PreviewPanel projectId={projectId} iframeReference={previewIframeReference} className="h-full" />
										</Suspense>
									</Panel>

									{/* DevTools panel (resizable) */}
									{devtoolsVisible && (
										<>
											<ResizeHandle
												className="
													h-0.5 bg-border transition-colors
													hover:bg-accent
													data-[separator=active]:bg-accent
													data-[separator=hover]:bg-accent
												"
											/>
											<Panel id="devtools" defaultSize="30%" minSize="15%" maxSize="80%">
												<Suspense fallback={<PanelSkeleton label="Loading DevTools..." />}>
													<DevelopmentToolsPanel previewIframeReference={previewIframeReference} className="h-full" />
												</Suspense>
											</Panel>
										</>
									)}
								</PanelGroup>
							</Panel>

							{/* AI Assistant panel */}
							{aiPanelVisible && (
								<>
									<ResizeHandle
										className="
											w-0.5 bg-border transition-colors
											hover:bg-accent
											data-[separator=active]:bg-accent
											data-[separator=hover]:bg-accent
										"
									/>
									<Panel id="ai-panel" defaultSize="20%" minSize="15%" maxSize="35%">
										<aside className="flex h-full flex-col border-l border-border">
											<Suspense fallback={<PanelSkeleton label="Loading AI assistant..." />}>
												<AIPanel projectId={projectId} className="h-full" />
											</Suspense>
										</aside>
									</Panel>
								</>
							)}
						</PanelGroup>

						{/* Status bar */}
						<footer
							className="
								flex h-6 shrink-0 items-center justify-between border-t border-border
								bg-bg-secondary px-3 text-xs text-text-secondary
							"
						>
							<div className="flex items-center gap-4">
								{isConnected ? (
									<span className="flex items-center gap-1.5">
										<span className="size-1.5 rounded-full" style={{ backgroundColor: localParticipantColor ?? 'var(--color-success)' }} />
										Connected
										{participants.length > 0 && (
											<span className="flex items-center gap-1">
												<span className="text-text-secondary">&middot;</span>
												{participants.map((participant) => (
													<span
														key={participant.id}
														className="size-2 rounded-full"
														style={{ backgroundColor: participant.color }}
														title={`Collaborator (${participant.id.slice(0, 6)})`}
													/>
												))}
												<span className="text-text-secondary">{participants.length} online</span>
											</span>
										)}
									</span>
								) : localParticipantColor ? (
									<span className="flex items-center gap-1.5">
										<span className="size-1.5 animate-pulse rounded-full" style={{ backgroundColor: localParticipantColor }} />
										Reconnecting
									</span>
								) : (
									<span className="flex items-center gap-1.5">
										<span className="size-1.5 rounded-full bg-error" />
										Disconnected
									</span>
								)}
							</div>
							<div className="flex items-center gap-4">
								{isSaving && <span>Saving...</span>}
								<a
									href="https://github.com/TimoWilhelm/worker-ide"
									target="_blank"
									rel="noopener noreferrer"
									className="
										transition-colors
										hover:text-accent
									"
									title="GitHub"
								>
									<Github className="size-3.5" />
								</a>
								<a href="/docs" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-accent">
									Worker IDE
								</a>
							</div>
						</footer>
					</>
				)}
			</div>
		</TooltipProvider>
	);
}

// =============================================================================
// Recent Projects Dropdown
// =============================================================================

function RecentProjectsDropdown({ currentProjectId, onNewProject }: { currentProjectId: string; onNewProject: () => void }) {
	const [projects, setProjects] = useState<RecentProject[]>([]);

	const handleOpenChange = useCallback((open: boolean) => {
		if (open) {
			setProjects(getRecentProjects());
		}
	}, []);

	const handleDeleteProject = useCallback((event: React.MouseEvent, projectId: string) => {
		event.preventDefault();
		event.stopPropagation();
		removeProject(projectId);
		setProjects((previous) => previous.filter((project) => project.id !== projectId));
	}, []);

	return (
		<DropdownMenu onOpenChange={handleOpenChange}>
			<Tooltip content="Recent Projects" side="bottom">
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon">
						<Clock className="size-4" />
					</Button>
				</DropdownMenuTrigger>
			</Tooltip>
			<DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
				{projects.map((project) => {
					const isCurrent = project.id === currentProjectId;
					return (
						<DropdownMenuItem
							key={project.id}
							onSelect={() => {
								if (!isCurrent) {
									globalThis.location.href = `/p/${project.id}`;
								}
							}}
							className={cn('group/item', isCurrent && 'bg-accent/10 text-accent')}
						>
							<div className="flex w-full items-center justify-between">
								<span className="truncate text-xs">
									{project.name ?? project.id.slice(0, 8)}
									{isCurrent && ' (current)'}
								</span>
								<div className="ml-2 flex shrink-0 items-center gap-1">
									<span className={cn('text-xs text-text-secondary', !isCurrent && 'group-hover/item:hidden')}>
										{formatRelativeTime(project.timestamp)}
									</span>
									{!isCurrent && (
										<button
											onPointerDown={(event) => event.stopPropagation()}
											onClick={(event) => handleDeleteProject(event, project.id)}
											className="
												hidden rounded-sm p-0.5 text-text-secondary/60 transition-colors
												group-hover/item:inline-flex
												hover:text-error
											"
											aria-label={`Remove ${project.name ?? project.id.slice(0, 8)} from recent projects`}
										>
											<X className="size-3" />
										</button>
									)}
								</div>
							</div>
						</DropdownMenuItem>
					);
				})}
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onNewProject}>
					<Plus className="size-3.5" />
					<span>New Project</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
