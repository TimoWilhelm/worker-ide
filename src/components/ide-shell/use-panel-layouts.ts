/**
 * Hook for computing and persisting resizable panel layouts via react-resizable-panels.
 */

import { useMemo } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';

import { useStore } from '@/lib/store';

export function usePanelLayouts() {
	const aiPanelVisible = useStore((state) => state.aiPanelVisible);
	const utilityPanelVisible = useStore((state) => state.utilityPanelVisible);
	const devtoolsVisible = useStore((state) => state.devtoolsVisible);
	const dependenciesPanelVisible = useStore((state) => state.dependenciesPanelVisible);

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

	return {
		aiPanelVisible,
		utilityPanelVisible,
		devtoolsVisible,
		dependenciesPanelVisible,
		mainLayout,
		sidebarLayout,
		editorTerminalLayout,
		previewDevtoolsLayout,
	};
}
