/**
 * useAiSessions Hook
 *
 * Manages AI session listing, loading, and auto-restore via Agent SDK RPC.
 * Sessions are stored on the AgentRunner DO and auto-synced via agent.state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useStore } from '@/lib/store';

import type { AgentState } from '@shared/agent-state';

// =============================================================================
// Helpers
// =============================================================================

/**
 * localStorage key for the active session ID, scoped per project.
 */
function activeSessionKey(projectId: string): string {
	return `worker-ide-active-session:${projectId}`;
}

/**
 * Read the active session ID for a project from localStorage.
 */
function getActiveSessionId(projectId: string): string | undefined {
	try {
		return localStorage.getItem(activeSessionKey(projectId)) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Write (or clear) the active session ID for a project in localStorage.
 */
export function setActiveSessionId(projectId: string, sessionId: string | undefined): void {
	try {
		if (sessionId) {
			localStorage.setItem(activeSessionKey(projectId), sessionId);
		} else {
			localStorage.removeItem(activeSessionKey(projectId));
		}
	} catch {
		// Ignore localStorage errors (private browsing, storage full, etc.)
	}
}

// =============================================================================
// Hook
// =============================================================================

interface AgentHandle {
	state: unknown;
	call: <T = unknown>(method: string, arguments_?: unknown[]) => Promise<T>;
}

export function useAiSessions({ projectId, agent }: { projectId: string; agent: AgentHandle }) {
	// Session list comes from agent.state.sessions (auto-synced)
	const rawState = agent.state;
	const agentState =
		rawState && typeof rawState === 'object' && 'sessions' in rawState
			? (rawState as AgentState) // eslint-disable-line @typescript-eslint/consistent-type-assertions -- narrowed above
			: undefined;
	const savedSessions = agentState?.sessions ?? [];

	// =========================================================================
	// Load a session via Agent RPC
	// =========================================================================

	const [isLoadingSession, setIsLoadingSession] = useState(false);

	const handleLoadSession = useCallback(
		(targetSessionId: string) => {
			setIsLoadingSession(true);
			void agent.call('loadSession', [targetSessionId]).finally(() => {
				setIsLoadingSession(false);
			});
		},
		[agent],
	);

	// =========================================================================
	// Auto-restore the active session on mount
	// =========================================================================

	const hasRestoredReference = useRef(false);

	// Eagerly check if there's a session to restore so the loading indicator
	// renders on the very first frame, avoiding a flash of the welcome screen.
	const [isRestoringSession, setIsRestoringSession] = useState(() => {
		const currentSession = agentState?.currentSession;
		return !currentSession && !!getActiveSessionId(projectId);
	});

	useEffect(() => {
		if (hasRestoredReference.current) return;
		hasRestoredReference.current = true;

		// Load pending changes from the agent
		void agent
			.call('loadPendingChanges')
			.then((pendingRecord) => {
				if (pendingRecord && typeof pendingRecord === 'object') {
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime-checked object from @callable RPC
					const record = pendingRecord as Record<string, import('@shared/types').PendingFileChange>;
					if (Object.keys(record).length > 0) {
						const pendingMap = new Map(Object.entries(record));
						useStore.getState().loadPendingChanges(pendingMap);
					}
				}
			})
			.catch((error: unknown) => {
				console.error('Failed to load pending changes:', error);
			});

		const currentSession = agentState?.currentSession;
		if (currentSession) {
			queueMicrotask(() => setIsRestoringSession(false));
		} else {
			const activeId = getActiveSessionId(projectId);
			if (!activeId) {
				queueMicrotask(() => setIsRestoringSession(false));
				return;
			}

			void agent.call('loadSession', [activeId]).finally(() => {
				setIsRestoringSession(false);
			});
		}
	}, [projectId, agent, agentState?.currentSession]);

	return {
		savedSessions,
		handleLoadSession,
		isRestoringSession: isRestoringSession || isLoadingSession,
	};
}
