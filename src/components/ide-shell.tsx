/**
 * IDE Shell Component
 *
 * Main IDE layout with resizable panels: file tree, editor, terminal, preview, and AI assistant.
 */

import { Bot, ChevronDown, ChevronUp, Clock, Download, Hexagon, Moon, Pencil, Plus, Sun } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Group as PanelGroup, Panel, Separator as ResizeHandle } from 'react-resizable-panels';

import { BorderBeam } from '@/components/ui/border-beam';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PanelSkeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { CodeEditor, computeDiffData, FileTabs, useFileContent } from '@/features/editor';
import { FileTree, useFileTree } from '@/features/file-tree';
import { getLogSnapshot, subscribeToLogs } from '@/features/terminal/lib/log-buffer';
import { hmrSendReference, useHMR, useTheme } from '@/hooks';
import { createProject, downloadProject, fetchProjectMeta, updateProjectMeta } from '@/lib/api-client';
import { getRecentProjects, trackProject, type RecentProject } from '@/lib/recent-projects';
import { selectIsProcessing, useStore } from '@/lib/store';
import { cn, formatRelativeTime } from '@/lib/utils';

import type { LogCounts } from '@/features/terminal';

// Lazy-loaded feature panels for code splitting
const AIPanel = lazy(() => import('@/features/ai-assistant'));
const PreviewPanel = lazy(() => import('@/features/preview'));
const TerminalPanel = lazy(() => import('@/features/terminal'));

// =============================================================================
// IDE Shell
// =============================================================================

export function IDEShell({ projectId }: { projectId: string }) {
	// HMR connection
	useHMR({ projectId });

	// Theme
	const resolvedTheme = useTheme();
	const setColorScheme = useStore((state) => state.setColorScheme);

	// Store state
	const {
		terminalVisible,
		toggleTerminal,
		aiPanelVisible,
		toggleAIPanel,
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
		participants,
		cursorPosition,
		pendingChanges,
		approveChange,
	} = useStore();

	// Read AI processing state via a dedicated selector to limit re-renders
	const isAiProcessing = useStore(selectIsProcessing);

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
			try {
				await updateProjectMeta(projectId, trimmed);
				setProjectName(trimmed);
				trackProject(projectId, trimmed);
			} catch {
				// Rename failed, silently revert
			}
		}
		setIsEditingName(false);
	}, [editNameValue, projectName, projectId]);

	const handleCancelRename = useCallback(() => {
		setIsEditingName(false);
	}, []);

	// Terminal log counts — derived from the global log buffer
	const logs = useSyncExternalStore(subscribeToLogs, getLogSnapshot);
	const logCounts = useMemo<LogCounts>(() => {
		let errors = 0;
		let warnings = 0;
		let logCount = 0;
		for (const entry of logs) {
			if (entry.level === 'error') errors++;
			else if (entry.level === 'warn') warnings++;
			else logCount++;
		}
		return { errors, warnings, logs: logCount };
	}, [logs]);

	// Auto-open terminal when errors arrive
	const previousErrorCount = useRef(0);
	useEffect(() => {
		if (logCounts.errors > previousErrorCount.current && !terminalVisible) {
			toggleTerminal();
		}
		previousErrorCount.current = logCounts.errors;
	}, [logCounts.errors, terminalVisible, toggleTerminal]);

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
	// Uses the actual editor content (not stored afterContent) so decorations
	// stay accurate when the user makes local edits.
	const activeDiffData = useMemo(() => {
		if (!activeFile) return;
		const pendingChange = pendingChanges.get(activeFile);
		if (!pendingChange || pendingChange.status !== 'pending') return;
		return computeDiffData(pendingChange.beforeContent, editorContent);
	}, [activeFile, pendingChanges, editorContent]);

	// Build tabs data
	const tabs = openFiles.map((path) => ({
		path,
		hasUnsavedChanges: unsavedChanges.get(path) ?? false,
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

	// Wrap selectFile: autosave current file before switching
	const handleSelectFile = useCallback(
		(path: string) => {
			void handleSaveReference.current();
			selectFile(path);
		},
		[selectFile],
	);

	// Wrap closeFile: autosave current file before closing
	const handleCloseFile = useCallback(
		(path: string) => {
			void handleSaveReference.current();
			closeFile(path);
		},
		[closeFile],
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

	// Handle new project
	const handleNewProject = useCallback(async () => {
		try {
			const data = await createProject();
			trackProject(data.projectId, data.name);
			globalThis.location.href = data.url;
		} catch (error) {
			console.error('Failed to create new project:', error);
		}
	}, []);

	// Send cursor updates to collaborators (debounced)
	const cursorUpdateTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const handleCursorChange = useCallback(
		(position: { line: number; column: number }) => {
			setCursorPosition(position);

			// Debounce WebSocket cursor update
			clearTimeout(cursorUpdateTimeoutReference.current);
			cursorUpdateTimeoutReference.current = setTimeout(() => {
				hmrSendReference.current?.({
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
			if (event.data?.type === '__open-file' && typeof event.data.file === 'string') {
				const file: string = event.data.file;
				const line = typeof event.data.line === 'number' ? event.data.line : 1;
				const column = typeof event.data.column === 'number' ? event.data.column : 1;
				goToFilePosition(file, { line, column });
			}
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [goToFilePosition]);

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

	return (
		<TooltipProvider>
			<div className="flex h-screen flex-col overflow-hidden bg-bg-primary">
				{/* Header */}
				<header
					className="
						flex h-10 shrink-0 items-center justify-between border-b border-border
						bg-bg-secondary px-3
					"
				>
					<div className="flex items-center gap-2">
						<Hexagon className="size-4 text-accent" />
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
								<h1 className="text-sm font-semibold text-text-primary">{projectName ?? 'Worker IDE'}</h1>
								<Tooltip content="Rename project">
									<button
										onClick={handleStartRename}
										className="
											cursor-pointer text-text-secondary opacity-0 transition-opacity
											group-hover:opacity-100
											hover:text-accent
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

						{/* AI toggle */}
						<Tooltip content="Toggle AI panel">
							<div className="relative">
								<Button
									variant="ghost"
									size="icon"
									aria-label="Toggle AI panel"
									onClick={toggleAIPanel}
									className={cn(aiPanelVisible && 'text-accent')}
								>
									<Bot className="size-4" />
								</Button>
								{isAiProcessing && !aiPanelVisible && <BorderBeam duration={1.5} />}
							</div>
						</Tooltip>

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

				{/* Main content — fully resizable panel layout */}
				<PanelGroup orientation="horizontal" id="ide-main" className="min-h-0 flex-1">
					{/* Sidebar — file explorer */}
					<Panel id="sidebar" defaultSize="15%" minSize="180px" maxSize="25%">
						<aside className="flex h-full flex-col border-r border-border bg-bg-secondary">
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
									onFileSelect={handleSelectFile}
									onDirectoryToggle={toggleDirectory}
									onCreateFile={handleCreateFile}
									onDeleteFile={deleteFile}
									className="flex-1"
								/>
							)}
						</aside>
					</Panel>

					<ResizeHandle
						className="
							w-1 bg-border transition-colors
							hover:bg-accent
							data-[separator=active]:bg-accent
							data-[separator=hover]:bg-accent
						"
					/>

					{/* Editor + Terminal column */}
					<Panel id="editor-col" defaultSize="45%" minSize="20%">
						<div className="flex h-full flex-col overflow-hidden">
							<PanelGroup orientation="vertical" id="ide-editor-terminal" className="flex-1">
								{/* Editor area */}
								<Panel id="editor" defaultSize={terminalVisible ? '70%' : '100%'} minSize="30%">
									<div className="flex h-full flex-col overflow-hidden">
										<FileTabs
											tabs={tabs}
											activeTab={activeFile}
											onSelect={handleSelectFile}
											onClose={handleCloseFile}
											participants={participants}
										/>
										<div className="flex-1 overflow-hidden">
											{activeFile ? (
												isLoadingContent ? (
													<div className="flex h-full items-center justify-center">
														<Spinner size="md" />
													</div>
												) : (
													<CodeEditor
														value={editorContent}
														filename={activeFile}
														onChange={handleEditorChange}
														onCursorChange={handleCursorChange}
														onBlur={handleEditorBlur}
														goToPosition={pendingGoTo}
														onGoToPositionConsumed={clearPendingGoTo}
														diffData={activeDiffData}
														resolvedTheme={resolvedTheme}
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

								{/* Terminal panel (resizable) */}
								{terminalVisible && (
									<>
										<ResizeHandle
											className="
												h-1 bg-border transition-colors
												hover:bg-accent
												data-[separator=active]:bg-accent
												data-[separator=hover]:bg-accent
											"
										/>
										<Panel id="terminal" defaultSize="30%" minSize="10%" maxSize="60%">
											<div className="flex h-full flex-col overflow-hidden">
												{/* Terminal header */}
												<button
													type="button"
													onClick={toggleTerminal}
													className={cn(
														`
															flex h-8 w-full shrink-0 cursor-pointer items-center
															justify-between
														`,
														'border-b border-border bg-bg-secondary px-2 transition-colors',
														'hover:bg-bg-tertiary',
													)}
													aria-label="Hide terminal"
												>
													<div className="flex items-center gap-2">
														<ChevronDown className="size-3 text-text-secondary" />
														<span className="text-xs font-medium text-text-secondary">Terminal</span>
														{logCounts.errors > 0 && (
															<span
																className="
																	inline-flex items-center rounded-full bg-red-500/15 px-1.5
																	py-0.5 text-2xs leading-none font-medium text-red-400
																"
															>
																{logCounts.errors}
															</span>
														)}
														{logCounts.warnings > 0 && (
															<span
																className="
																	inline-flex items-center rounded-full bg-yellow-500/15 px-1.5
																	py-0.5 text-2xs leading-none font-medium text-yellow-400
																"
															>
																{logCounts.warnings}
															</span>
														)}
													</div>
													<div className="flex items-center gap-3 text-xs text-text-secondary">
														{activeFile && <span className="truncate">{activeFile}</span>}
														{cursorPosition && (
															<span>
																Ln {cursorPosition.line}, Col {cursorPosition.column}
															</span>
														)}
													</div>
												</button>
												<div className="flex-1 overflow-hidden">
													<Suspense fallback={<PanelSkeleton label="Loading terminal..." />}>
														<TerminalPanel projectId={projectId} className="h-full" />
													</Suspense>
												</div>
											</div>
										</Panel>
									</>
								)}
							</PanelGroup>

							{/* Terminal toggle bar when terminal is hidden */}
							{!terminalVisible && (
								<button
									type="button"
									onClick={toggleTerminal}
									className={cn(
										'flex h-7 w-full shrink-0 cursor-pointer items-center',
										'border-t border-border bg-bg-secondary px-2 transition-colors',
										'hover:bg-bg-tertiary',
									)}
									aria-label="Show terminal"
								>
									<div className="flex items-center gap-2">
										<ChevronUp className="size-3 text-text-secondary" />
										<span className="text-xs font-medium text-text-secondary">Terminal</span>
										{logCounts.errors > 0 && (
											<span
												className="
													inline-flex items-center rounded-full bg-red-500/15 px-1.5 py-0.5
													text-2xs leading-none font-medium text-red-400
												"
											>
												{logCounts.errors}
											</span>
										)}
										{logCounts.warnings > 0 && (
											<span
												className="
													inline-flex items-center rounded-full bg-yellow-500/15 px-1.5
													py-0.5 text-2xs leading-none font-medium text-yellow-400
												"
											>
												{logCounts.warnings}
											</span>
										)}
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
							w-1 bg-border transition-colors
							hover:bg-accent
							data-[separator=active]:bg-accent
							data-[separator=hover]:bg-accent
						"
					/>

					{/* Preview panel */}
					<Panel id="preview" defaultSize={aiPanelVisible ? '20%' : '40%'} minSize="15%">
						<Suspense fallback={<PanelSkeleton label="Loading preview..." />}>
							<PreviewPanel projectId={projectId} className="h-full" />
						</Suspense>
					</Panel>

					{/* Snapshot panel (part of AI sidebar area) */}
					{/* AI Assistant panel */}
					{aiPanelVisible && (
						<>
							<ResizeHandle
								className="
									w-1 bg-border transition-colors
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
								<span className="size-1.5 rounded-full bg-success" />
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
						) : (
							<span className="flex items-center gap-1.5">
								<span className="size-1.5 rounded-full bg-error" />
								Disconnected
							</span>
						)}
					</div>
					<div className="flex items-center gap-4">
						{isSaving && <span>Saving...</span>}
						<span>Worker IDE</span>
					</div>
				</footer>
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

	return (
		<DropdownMenu onOpenChange={handleOpenChange}>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" title="Recent Projects">
					<Clock className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-60">
				{projects.length <= 1 ? (
					<div className="px-3 py-2 text-center text-xs text-text-secondary">No other projects yet</div>
				) : (
					projects.map((project) => {
						const isCurrent = project.id === currentProjectId;
						return (
							<DropdownMenuItem
								key={project.id}
								onSelect={() => {
									if (!isCurrent) {
										globalThis.location.href = `/p/${project.id}`;
									}
								}}
								className={cn(isCurrent && 'bg-accent/10 text-accent')}
							>
								<div className="flex w-full items-center justify-between">
									<span className="truncate text-xs">
										{project.name ?? project.id.slice(0, 8)}
										{isCurrent && ' (current)'}
									</span>
									<span className="ml-2 shrink-0 text-xs text-text-secondary">{formatRelativeTime(project.timestamp)}</span>
								</div>
							</DropdownMenuItem>
						);
					})
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onNewProject}>
					<Plus className="size-3.5" />
					<span>New Project</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
