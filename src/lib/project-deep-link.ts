import { useCallback } from 'react';

import { useFileTargetOpener } from '@/lib/file-target';
import { useStore } from '@/lib/store';

import type { ProjectDeepLinkTarget } from '@shared/project-deep-link';

interface ProjectDeepLinkActions {
	openFileTarget: (target: { path: string; position?: { line: number; column: number } }) => void;
	requestAgentSession: (sessionId: string) => void;
	setActiveMobilePanel: (panel: 'editor' | 'preview' | 'git' | 'agent' | 'tests') => void;
	showAgentPanel: () => void;
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

	actions.setActiveMobilePanel(target.panel);
}

export function useProjectDeepLinkApplier(): (target: ProjectDeepLinkTarget) => void {
	const openFileTarget = useFileTargetOpener();
	const requestAgentSession = useStore((state) => state.requestAgentSession);
	const setActiveMobilePanel = useStore((state) => state.setActiveMobilePanel);
	const showAgentPanel = useStore((state) => state.showAgentPanel);

	return useCallback(
		(target: ProjectDeepLinkTarget) => {
			applyProjectDeepLink(target, {
				openFileTarget,
				requestAgentSession,
				setActiveMobilePanel,
				showAgentPanel,
			});
		},
		[openFileTarget, requestAgentSession, setActiveMobilePanel, showAgentPanel],
	);
}
