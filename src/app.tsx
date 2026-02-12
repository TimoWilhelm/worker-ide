/**
 * Root Application Component
 *
 * Sets up global providers (React Query, error boundaries) and routes.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PanelLeftClose, PanelLeftOpen, Download, WifiOff, Wifi, Terminal, Bot, History } from 'lucide-react';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { ErrorBoundary } from '@/components/error-boundary';
import { Button } from '@/components/ui/button';
import { ResizablePanel } from '@/components/ui/resizable-panel';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { AIPanel } from '@/features/ai-assistant';
import { CodeEditor, FileTabs, useFileContent } from '@/features/editor';
import { FileTree, useFileTree } from '@/features/file-tree';
import { PreviewPanel } from '@/features/preview';
import { SnapshotPanel } from '@/features/snapshots';
import { TerminalPanel } from '@/features/terminal';
import { useHMR } from '@/hooks';
import { downloadProject } from '@/lib/api-client';
import { useStore } from '@/lib/store';

// Create a stable QueryClient instance
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 1000 * 60, // 1 minute
			retry: 1,
			refetchOnWindowFocus: false,
		},
	},
});

/**
 * Loading fallback component for Suspense boundaries.
 */
function LoadingFallback() {
	return (
		<div className="flex h-screen items-center justify-center bg-bg-primary">
			<div className="flex flex-col items-center gap-4">
				<Spinner size="lg" />
				<p className="text-text-secondary">Loading Worker IDE...</p>
			</div>
		</div>
	);
}

/**
 * Error fallback component for error boundaries.
 */
function ErrorFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
	return (
		<div className="flex h-screen items-center justify-center bg-bg-primary">
			<div className="max-w-md rounded-lg border border-error bg-bg-secondary p-6">
				<h1 className="mb-2 text-lg font-semibold text-error">Something went wrong</h1>
				<pre
					className={`
						mb-4 overflow-auto rounded-sm bg-bg-tertiary p-3 font-mono text-sm
						text-text-secondary
					`}
				>
					{error.message}
				</pre>
				<button
					onClick={resetErrorBoundary}
					className="
						rounded-sm bg-accent px-4 py-2 text-sm font-medium text-white
						transition-colors
						hover:bg-accent-hover
					"
				>
					Try again
				</button>
			</div>
		</div>
	);
}

/**
 * Main application content.
 * This component handles routing and renders the appropriate page.
 */
function getProjectIdFromUrl(): string | undefined {
	const path = globalThis.location.pathname;
	const match = path.match(/^\/p\/([a-f0-9]{64})/i);
	if (match) {
		return match[1].toLowerCase();
	}
	return undefined;
}

function shouldCreateNewProject(): boolean {
	const path = globalThis.location.pathname;
	return !getProjectIdFromUrl() && (path === '/' || path === '');
}

function AppContent() {
	const [projectId] = useState(getProjectIdFromUrl);
	const [isCreatingProject, setIsCreatingProject] = useState(shouldCreateNewProject);

	// Redirect to a new project if no project ID in URL
	useEffect(() => {
		if (!isCreatingProject) return;
		void (async () => {
			try {
				const response = await fetch('/api/new-project', { method: 'POST' });
				const data: { projectId: string; url: string } = await response.json();
				globalThis.location.href = data.url;
			} catch (error) {
				console.error('Failed to create project:', error);
				setIsCreatingProject(false);
			}
		})();
	}, [isCreatingProject]);

	if (isCreatingProject) {
		return (
			<div className="flex h-screen items-center justify-center bg-bg-primary">
				<div className="flex flex-col items-center gap-4">
					<Spinner size="lg" />
					<p className="text-text-secondary">Creating new project...</p>
				</div>
			</div>
		);
	}

	if (!projectId) {
		return <LoadingFallback />;
	}

	// Lazy load the IDE component
	return (
		<Suspense fallback={<LoadingFallback />}>
			<IDEShell projectId={projectId} />
		</Suspense>
	);
}

/**
 * IDE Shell - Main layout component.
 * Contains the header, sidebar (file tree), editor, and future panels.
 */
function IDEShell({ projectId }: { projectId: string }) {
	// HMR connection
	useHMR({ projectId });

	// Store state
	const {
		sidebarVisible,
		toggleSidebar,
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
		isConnected,
		sidebarWidth,
		terminalHeight,
		setTerminalHeight,
		cursorPosition,
	} = useStore();

	// Snapshot panel toggle (local state, not persisted)
	const [snapshotPanelVisible, setSnapshotPanelVisible] = useState(false);
	const toggleSnapshotPanel = useCallback(() => setSnapshotPanelVisible((previous) => !previous), []);

	// File tree hook
	const { files, selectedFile, expandedDirectories, selectFile, toggleDirectory, isLoading: isLoadingFiles } = useFileTree({ projectId });

	// File content hook (for active file)
	const { content, isLoading: isLoadingContent, saveFile, isSaving } = useFileContent({ projectId, path: activeFile });

	// Track local editor edits (undefined = no local edits, use server content)
	const [localEditorContent, setLocalEditorContent] = useState<string>();

	// Reset local edits when server content changes (new file loaded)
	const [previousContent, setPreviousContent] = useState(content);
	if (content !== previousContent) {
		setPreviousContent(content);
		setLocalEditorContent(undefined);
	}

	// Effective editor content: local edits take priority over server content
	const editorContent = localEditorContent ?? content ?? '';

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
			}
		},
		[activeFile, content, markFileChanged],
	);

	// Handle save (Ctrl+S)
	const handleSave = useCallback(() => {
		if (activeFile && unsavedChanges.get(activeFile)) {
			saveFile(editorContent);
			markFileChanged(activeFile, false);
		}
	}, [activeFile, unsavedChanges, saveFile, editorContent, markFileChanged]);

	// Handle download
	const handleDownload = useCallback(async () => {
		try {
			const blob = await downloadProject(projectId);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `project-${projectId.slice(0, 8)}.zip`;
			document.body.append(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error('Failed to download project:', error);
		}
	}, [projectId]);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key === 's') {
				event.preventDefault();
				handleSave();
			}
		};

		globalThis.addEventListener('keydown', handleKeyDown);
		return () => globalThis.removeEventListener('keydown', handleKeyDown);
	}, [handleSave]);

	return (
		<TooltipProvider>
			<div className="flex h-screen flex-col bg-bg-primary">
				{/* Header */}
				<header
					className={`
						flex h-12 shrink-0 items-center justify-between border-b border-border
						bg-bg-secondary px-4
					`}
				>
					<div className="flex items-center gap-4">
						<Tooltip content={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}>
							<Button variant="ghost" size="icon" aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'} onClick={toggleSidebar}>
								{sidebarVisible ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
							</Button>
						</Tooltip>
						<h1 className="font-semibold text-text-primary">Worker IDE</h1>
						<span className="font-mono text-xs text-text-secondary">Project: {projectId.slice(0, 8)}...</span>
					</div>
					<div className="flex items-center gap-2">
						{/* Connection status */}
						<Tooltip content={isConnected ? 'Connected' : 'Disconnected'}>
							<div className="flex items-center gap-1 text-xs text-text-secondary" aria-label={isConnected ? 'Connected' : 'Disconnected'}>
								{isConnected ? <Wifi className="size-3 text-success" /> : <WifiOff className="h-3 w-3 text-error" />}
							</div>
						</Tooltip>
						{/* Save indicator */}
						{isSaving && <span className="text-xs text-text-secondary">Saving...</span>}

						<div className="mx-2 h-4 w-px bg-border" />

						{/* Toggle buttons */}
						<Tooltip content={terminalVisible ? 'Hide terminal' : 'Show terminal'}>
							<Button variant="ghost" size="icon" aria-label={terminalVisible ? 'Hide terminal' : 'Show terminal'} onClick={toggleTerminal}>
								<Terminal className={terminalVisible ? 'size-4 text-accent' : 'size-4'} />
							</Button>
						</Tooltip>
						<Tooltip content={snapshotPanelVisible ? 'Hide snapshots' : 'Show snapshots'}>
							<Button
								variant="ghost"
								size="icon"
								aria-label={snapshotPanelVisible ? 'Hide snapshots' : 'Show snapshots'}
								onClick={toggleSnapshotPanel}
							>
								<History className={snapshotPanelVisible ? 'size-4 text-accent' : 'size-4'} />
							</Button>
						</Tooltip>
						<Tooltip content={aiPanelVisible ? 'Hide AI' : 'Show AI'}>
							<Button variant="ghost" size="icon" aria-label={aiPanelVisible ? 'Hide AI' : 'Show AI'} onClick={toggleAIPanel}>
								<Bot className={aiPanelVisible ? 'size-4 text-accent' : 'size-4'} />
							</Button>
						</Tooltip>

						<div className="mx-2 h-4 w-px bg-border" />

						{/* Download button */}
						<Tooltip content="Download project">
							<Button variant="ghost" size="sm" aria-label="Download project" onClick={handleDownload}>
								<Download className="mr-1 size-4" />
								Download
							</Button>
						</Tooltip>
					</div>
				</header>

				{/* Main content */}
				<main className="flex flex-1 overflow-hidden">
					{/* Sidebar - File Tree */}
					{sidebarVisible && (
						<aside className="flex shrink-0 flex-col border-r border-border bg-bg-secondary" style={{ width: sidebarWidth }}>
							<div className="flex h-9 shrink-0 items-center border-b border-border px-3">
								<span className="text-xs font-medium text-text-secondary uppercase">Explorer</span>
							</div>
							{isLoadingFiles ? (
								<div className="flex flex-1 items-center justify-center">
									<Spinner size="sm" />
								</div>
							) : (
								<FileTree
									files={files}
									selectedFile={selectedFile}
									expandedDirectories={expandedDirectories}
									onFileSelect={selectFile}
									onDirectoryToggle={toggleDirectory}
									className="flex-1"
								/>
							)}
						</aside>
					)}

					{/* Center area - Editor + Terminal */}
					<div className="flex flex-1 flex-col overflow-hidden">
						{/* Editor area */}
						<div className="flex flex-1 flex-col overflow-hidden">
							{/* File tabs */}
							<FileTabs tabs={tabs} activeTab={activeFile} onSelect={selectFile} onClose={closeFile} />

							{/* Editor */}
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
											onCursorChange={setCursorPosition}
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

						{/* Terminal panel */}
						{terminalVisible && (
							<ResizablePanel
								direction="vertical"
								defaultSize={terminalHeight}
								minSize={100}
								maxSize={400}
								onSizeChange={setTerminalHeight}
								handlePosition="start"
							>
								<TerminalPanel projectId={projectId} className="h-full" />
							</ResizablePanel>
						)}
					</div>

					{/* Right panel - Preview */}
					<div className="flex w-[45%] shrink-0 flex-col border-l border-border">
						<PreviewPanel projectId={projectId} className="flex-1" />
					</div>

					{/* Snapshot panel */}
					{snapshotPanelVisible && (
						<aside className="flex w-72 shrink-0 flex-col border-l border-border">
							<SnapshotPanel projectId={projectId} className="h-full" onClose={toggleSnapshotPanel} />
						</aside>
					)}

					{/* AI Assistant panel */}
					{aiPanelVisible && (
						<aside className="flex w-80 shrink-0 flex-col border-l border-border">
							<AIPanel projectId={projectId} className="h-full" />
						</aside>
					)}
				</main>

				{/* Status bar */}
				<footer
					className={`
						flex h-6 shrink-0 items-center justify-between border-t border-border
						bg-bg-secondary px-4 text-xs text-text-secondary
					`}
				>
					<div className="flex items-center gap-4">{activeFile && <span>{activeFile}</span>}</div>
					<div className="flex items-center gap-4">
						{cursorPosition && (
							<span>
								Ln {cursorPosition.line}, Col {cursorPosition.column}
							</span>
						)}
					</div>
				</footer>
			</div>
		</TooltipProvider>
	);
}

/**
 * Root App component with all providers.
 */
export function App() {
	return (
		<ErrorBoundary fallback={ErrorFallback}>
			<QueryClientProvider client={queryClient}>
				<AppContent />
			</QueryClientProvider>
		</ErrorBoundary>
	);
}
