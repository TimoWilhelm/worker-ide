import { useCallback } from 'react';

import { useFileTargetOpener } from '@/lib/file-target';
import { useStore } from '@/lib/store';

import type { ProjectDeepLinkTarget } from '@shared/project-deep-link';

interface ProjectDeepLinkActions {
	openFileTarget: (target: { path: string; position?: { line: number; column: number } }) => void;
	requestAgentSession: (sessionId: string) => void;
	setActiveMobilePanel: (panel: 'editor' | 'preview' | 'git' | 'agent' | 'tests') => void;
	setActiveSidebarView: (view: 'explorer' | 'git' | 'tests') => void;
	showAgentPanel: () => void;
	showDependenciesPanel: () => void;
}

export function applyProjectDeepLink(target: ProjectDeepLinkTarget, actions: ProjectDeepLinkActions): void {
	if (target.kind === 'agent-session') {
		actions.requestAgentSession(target.sessionId);
		return;
	}

	if (target.kind === 'file') {
		const position =
			target.file.line === undefined
				? undefined
				: {
						line: target.file.line,
						column: target.file.column ?? 1,
					};

		actions.openFileTarget({
			path: target.file.path,
			...(position === undefined ? {} : { position }),
		});
		return;
	}

	if (target.panel === 'agent') {
		actions.showAgentPanel();
		return;
	}

	if (target.panel === 'dependencies') {
		actions.setActiveSidebarView('explorer');
		actions.showDependenciesPanel();
		actions.setActiveMobilePanel('editor');
		return;
	}

	actions.setActiveMobilePanel(target.panel);
}

export function useProjectDeepLinkApplier(): (target: ProjectDeepLinkTarget) => void {
	const openFileTarget = useFileTargetOpener();
	const requestAgentSession = useStore((state) => state.requestAgentSession);
	const setActiveMobilePanel = useStore((state) => state.setActiveMobilePanel);
	const setActiveSidebarView = useStore((state) => state.setActiveSidebarView);
	const showAgentPanel = useStore((state) => state.showAgentPanel);
	const showDependenciesPanel = useStore((state) => state.showDependenciesPanel);

	return useCallback(
		(target: ProjectDeepLinkTarget) => {
			applyProjectDeepLink(target, {
				openFileTarget,
				requestAgentSession,
				setActiveMobilePanel,
				setActiveSidebarView,
				showAgentPanel,
				showDependenciesPanel,
			});
		},
		[openFileTarget, requestAgentSession, setActiveMobilePanel, setActiveSidebarView, showAgentPanel, showDependenciesPanel],
	);
}
