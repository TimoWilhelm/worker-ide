/**
 * Desktop IDE layout — fully resizable panel layout with sidebar, editor, preview, and AI.
 */

import { ChevronUp } from 'lucide-react';
import { lazy, Suspense, useCallback } from 'react';
import { Group as PanelGroup, Panel, Separator as ResizeHandle } from 'react-resizable-panels';

import { ActivityBar } from '@/components/activity-bar';
import { Pill } from '@/components/ui/pill';
import { PanelSkeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { DependencyPanel, FileTree, type useFileTree } from '@/features/file-tree';
import { GitPanel } from '@/features/git';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { EditorArea } from './editor-area';
import { IDEStatusBar } from './ide-status-bar';

import type { useEditorState } from './use-editor-state';
import type { usePanelLayouts } from './use-panel-layouts';
import type { LogCounts } from '@/features/output';

const AIPanel = lazy(() => import('@/features/ai-assistant'));
const DevelopmentToolsPanel = lazy(() => import('@/features/devtools'));
const PreviewPanel = lazy(() => import('@/features/preview'));
const UtilityPanel = lazy(() => import('@/features/utility-panel'));

interface DesktopLayoutProperties {
	projectId: string;
	resolvedTheme: 'light' | 'dark';
	editorState: ReturnType<typeof useEditorState>;
	fileTree: ReturnType<typeof useFileTree>;
	layouts: ReturnType<typeof usePanelLayouts>;
	logCounts: LogCounts;
	previewIframeReference: React.RefObject<HTMLIFrameElement | null>;
}

export function DesktopLayout({
	projectId,
	resolvedTheme,
	editorState,
	fileTree,
	layouts,
	logCounts,
	previewIframeReference,
}: DesktopLayoutProperties) {
	const activeSidebarView = useStore((state) => state.activeSidebarView);
	const toggleUtilityPanel = useStore((state) => state.toggleUtilityPanel);
	const toggleDependenciesPanel = useStore((state) => state.toggleDependenciesPanel);
	const isConnected = useStore((state) => state.isConnected);
	const localParticipantColor = useStore((state) => state.localParticipantColor);

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
	} = fileTree;

	const { activeFile, participants, cursorPosition, isSaving, gitStatusMap } = editorState;

	const {
		aiPanelVisible,
		utilityPanelVisible,
		devtoolsVisible,
		dependenciesPanelVisible,
		mainLayout,
		sidebarLayout,
		editorTerminalLayout,
		previewDevtoolsLayout,
	} = layouts;

	const handleSelectFile = useCallback(
		(path: string) => {
			editorState.selectFileFromTree(path);
			selectFile(path);
		},
		[editorState, selectFile],
	);

	const handleCreateFile = useCallback(
		(path: string) => {
			createFile({ path, content: '' });
		},
		[createFile],
	);

	const handleRenameFile = useCallback(
		(fromPath: string, toPath: string) => {
			renameFile({ fromPath, toPath });
		},
		[renameFile],
	);

	const handleCreateFolder = useCallback(
		(path: string) => {
			createFolder(path);
		},
		[createFolder],
	);

	const handleMoveFile = useCallback(
		(fromPath: string, toPath: string) => {
			renameFile({ fromPath, toPath });
		},
		[renameFile],
	);

	return (
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
									{!dependenciesPanelVisible && <DependencyPanel projectId={projectId} collapsed onToggle={toggleDependenciesPanel} />}
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
									<EditorArea resolvedTheme={resolvedTheme} editorState={editorState} onSelectFile={handleSelectFile} />
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
													<div
														className="
															flex min-w-0 items-center gap-3 text-xs text-text-secondary
														"
													>
														{activeFile && <span className="truncate">{activeFile}</span>}
														{cursorPosition && (
															<span className="shrink-0">
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
								<div className="flex shrink-0 items-center gap-2">
									<ChevronUp className="size-3 text-text-secondary" />
									<span className="text-xs font-medium text-text-secondary">Output</span>
									{logCounts.errors > 0 && <Pill color="red">{logCounts.errors}</Pill>}
									{logCounts.warnings > 0 && <Pill color="yellow">{logCounts.warnings}</Pill>}
								</div>
								<div
									className="
										ml-auto flex min-w-0 items-center gap-3 text-xs text-text-secondary
									"
								>
									{activeFile && <span className="truncate">{activeFile}</span>}
									{cursorPosition && (
										<span className="shrink-0">
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
			<IDEStatusBar
				isConnected={isConnected}
				localParticipantColor={localParticipantColor}
				participants={participants}
				isSaving={isSaving}
			/>
		</>
	);
}
