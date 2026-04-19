import { useCallback, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentRuntimeProvider } from '@/features/ai-assistant';
import { DeployModal } from '@/features/deploy';
import { useFileTree } from '@/features/file-tree';
import { ProjectSettingsModal } from '@/features/project-settings';
import { useIsMobile, useProjectSocket, useTheme } from '@/hooks';
import { downloadProject } from '@/lib/api-client';
import { usePreviewUrl } from '@/lib/preview-origin';
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

	// Theme (still needed for editor/terminal theming in Desktop/Mobile layouts)
	const resolvedTheme = useTheme();

	// Mobile layout
	const isMobile = useIsMobile();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

	// Deploy modal
	const [deployModalOpen, setDeployModalOpen] = useState(false);

	// Project settings modal
	const [settingsModalOpen, setSettingsModalOpen] = useState(false);

	// Agent panel toggle
	const toggleAgentPanel = useStore((state) => state.toggleAgentPanel);
	const isAgentProcessing = useStore(selectIsProcessing);

	// Custom hooks
	const projectNameState = useProjectName({ projectId });
	const logCounts = useLogCounts();
	const editorState = useEditorState({ projectId });
	const layouts = usePanelLayouts(projectId);

	// Shared preview iframe ref for CDP message relay with DevTools
	const previewIframeReference = useRef<HTMLIFrameElement>(null);

	// File tree hook
	const fileTree = useFileTree({ projectId });

	// Signed preview URL (HMAC time-bucket token)
	const { previewUrl, previewOrigin, isLoading: isLoadingPreviewUrl, refresh: refreshPreviewUrl } = usePreviewUrl(projectId);

	// Side-effect-only hooks
	useIDEEffects({
		projectId,
		previewOrigin,
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
		} catch {
			toast.error('Could not download the project. Please check your connection and try again.');
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

	return (
		<TooltipProvider>
			<AgentRuntimeProvider key={projectId} projectId={projectId}>
				<title>{projectNameState.projectName ? `${projectNameState.projectName} | Codemaxxing` : 'Codemaxxing'}</title>
				<div className="flex h-full flex-col overflow-hidden bg-bg-primary">
					<IDEHeader
						projectNameState={projectNameState}
						isMobile={isMobile}
						aiPanelVisible={layouts.aiPanelVisible}
						toggleAgentPanel={toggleAgentPanel}
						isAgentProcessing={isAgentProcessing}
						mobileMenuOpen={mobileMenuOpen}
						setMobileMenuOpen={setMobileMenuOpen}
						onDownload={handleDownload}
						onDeploy={handleDeploy}
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
							previewUrl={previewUrl}
							previewOrigin={previewOrigin}
							isLoadingPreviewUrl={isLoadingPreviewUrl}
							refreshPreviewUrl={refreshPreviewUrl}
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
							previewUrl={previewUrl}
							previewOrigin={previewOrigin}
							isLoadingPreviewUrl={isLoadingPreviewUrl}
							refreshPreviewUrl={refreshPreviewUrl}
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
			</AgentRuntimeProvider>
		</TooltipProvider>
	);
}
