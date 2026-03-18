/**
 * IDE Shell Component
 *
 * Main IDE layout with resizable panels: file tree, editor, terminal, preview, and AI assistant.
 * This is the composition root that wires hooks and sub-components together.
 */

import { useCallback, useRef, useState } from 'react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { DeployModal } from '@/features/deploy';
import { useFileTree } from '@/features/file-tree';
import { ProjectSettingsModal } from '@/features/project-settings';
import { useIsMobile, useProjectSocket, useTheme } from '@/hooks';
import { downloadProject } from '@/lib/api-client';
import { selectIsProcessing, useStore } from '@/lib/store';

import { DesktopLayout } from './desktop-layout';
import { IDEHeader } from './ide-header';
import { MobileLayout } from './mobile-layout';
import { useEditorSessionPersistence } from './use-editor-session-persistence';
import { useEditorState } from './use-editor-state';
import { useIDEEffects } from './use-ide-effects';
import { useLogCounts } from './use-log-counts';
import { usePanelLayouts } from './use-panel-layouts';
import { useProjectName } from './use-project-name';

export function IDEShell({ projectId }: { projectId: string }) {
	// Restore and persist editor session (open tabs, active file, cursor/scroll positions)
	// Must run before useEditorState so the store is populated before the first render
	useEditorSessionPersistence({ projectId });

	// Project WebSocket connection (HMR notifications, collaboration, server events)
	useProjectSocket({ projectId });

	// Theme
	const resolvedTheme = useTheme();
	const setColorScheme = useStore((state) => state.setColorScheme);

	// Mobile layout
	const isMobile = useIsMobile();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

	// Deploy modal
	const [deployModalOpen, setDeployModalOpen] = useState(false);

	// Project settings modal
	const [settingsModalOpen, setSettingsModalOpen] = useState(false);

	// AI panel toggle
	const toggleAIPanel = useStore((state) => state.toggleAIPanel);
	const isAiProcessing = useStore(selectIsProcessing);

	// Custom hooks
	const projectNameState = useProjectName({ projectId });
	const logCounts = useLogCounts();
	const editorState = useEditorState({ projectId });
	const layouts = usePanelLayouts();

	// Shared preview iframe ref for CDP message relay with DevTools
	const previewIframeReference = useRef<HTMLIFrameElement>(null);

	// File tree hook
	const fileTree = useFileTree({ projectId });

	// Side-effect-only hooks
	useIDEEffects({
		projectId,
		goToFilePosition: editorState.goToFilePosition,
		handleSaveReference: editorState.handleSaveReference,
		previewIframeReference,
		cursorUpdateTimeoutReference: editorState.cursorUpdateTimeoutReference,
	});

	// Handle download
	const handleDownload = useCallback(async () => {
		try {
			const blob = await downloadProject(projectId);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${projectNameState.projectName ?? `project-${projectId.slice(0, 8)}`}.zip`;
			document.body.append(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error('Failed to download project:', error);
		}
	}, [projectId, projectNameState.projectName]);

	// Handle deploy
	const handleDeploy = useCallback(() => {
		setDeployModalOpen(true);
	}, []);

	// Handle settings
	const handleSettings = useCallback(() => {
		setSettingsModalOpen(true);
	}, []);

	// Navigate to dashboard to create a new project
	const handleNewProject = useCallback(() => {
		globalThis.location.href = '/';
	}, []);

	return (
		<TooltipProvider>
			<div className="flex h-full flex-col overflow-hidden bg-bg-primary">
				<IDEHeader
					projectId={projectId}
					projectNameState={projectNameState}
					resolvedTheme={resolvedTheme}
					setColorScheme={setColorScheme}
					isMobile={isMobile}
					isSaving={editorState.isSaving}
					aiPanelVisible={layouts.aiPanelVisible}
					toggleAIPanel={toggleAIPanel}
					isAiProcessing={isAiProcessing}
					mobileMenuOpen={mobileMenuOpen}
					setMobileMenuOpen={setMobileMenuOpen}
					onDownload={handleDownload}
					onDeploy={handleDeploy}
					onNewProject={handleNewProject}
					onSettings={handleSettings}
				/>

				{isMobile ? (
					<MobileLayout
						projectId={projectId}
						resolvedTheme={resolvedTheme}
						editorState={editorState}
						fileTree={fileTree}
						logCounts={logCounts}
						previewIframeReference={previewIframeReference}
					/>
				) : (
					<DesktopLayout
						projectId={projectId}
						resolvedTheme={resolvedTheme}
						editorState={editorState}
						fileTree={fileTree}
						layouts={layouts}
						logCounts={logCounts}
						previewIframeReference={previewIframeReference}
					/>
				)}
				<DeployModal
					open={deployModalOpen}
					onOpenChange={setDeployModalOpen}
					projectId={projectId}
					projectName={projectNameState.projectName ?? `project-${projectId.slice(0, 8)}`}
				/>
				<ProjectSettingsModal open={settingsModalOpen} onOpenChange={setSettingsModalOpen} projectId={projectId} />
			</div>
		</TooltipProvider>
	);
}
