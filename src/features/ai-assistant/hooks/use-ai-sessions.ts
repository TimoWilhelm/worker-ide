/**
 * useAiSessions Hook
 *
 * Manages AI session listing, loading, and auto-restore via Agent SDK RPC.
 * Sessions are stored on the AgentRunner DO and auto-synced via agent.state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useStore } from '@/lib/store';

import type { AgentState } from '@shared/agent-state';
import type { PendingFileChange } from '@shared/types';

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

	// Track the last-known session ID so we can distinguish "session genuinely
	// cleared" from "transient undefined during loadSession switch".
	const lastSessionIdReference = useRef(agentState?.currentSession?.sessionId);

	// Sync pendingChanges from agent state into the Zustand store in real-time.
	//
	// The server updates state.currentSession.pendingChanges as file-changed
	// events stream in and when sessions are reverted. The UI reads from the
	// Zustand store. This effect bridges the two:
	//   - New entries from agent state are added to the store
	//   - Entries removed from agent state (e.g. after revert) are removed
	//   - Client-side review state (status, hunkStatuses) is preserved
	const agentSessionId = agentState?.currentSession?.sessionId;
	const agentPendingChanges = agentState?.currentSession?.pendingChanges;
	useEffect(() => {
		const current = useStore.getState().pendingChanges;

		if (!agentPendingChanges) {
			// Only clear the store if the session was explicitly removed (sessionId
			// went from defined → undefined). Skip if sessionId was already undefined
			// (avoids clearing during transient loadSession switches).
			if (agentSessionId === undefined && lastSessionIdReference.current !== undefined) {
				lastSessionIdReference.current = undefined;
				if (current.size > 0) {
					useStore.getState().loadPendingChanges(new Map());
				}
			}
			return;
		}

		lastSessionIdReference.current = agentSessionId;

		const incomingKeys = Object.keys(agentPendingChanges);

		// Shallow-equality bail-out: skip if the set of paths and their
		// server-side content (snapshotId, action, afterContent) are unchanged.
		// This avoids creating a new Map on every agent state broadcast.
		if (incomingKeys.length === current.size) {
			let unchanged = true;
			for (const key of incomingKeys) {
				const existing = current.get(key);
				const incoming = agentPendingChanges[key];
				if (
					!existing ||
					existing.snapshotId !== incoming.snapshotId ||
					existing.action !== incoming.action ||
					existing.afterContent !== incoming.afterContent ||
					existing.beforeContent !== incoming.beforeContent
				) {
					unchanged = false;
					break;
				}
			}
			if (unchanged) return;
		}

		const merged = new Map<string, PendingFileChange>();

		for (const [path, change] of Object.entries(agentPendingChanges)) {
			const existing = current.get(path);
			if (existing) {
				// Preserve client-side review state (status, hunkStatuses)
				merged.set(path, { ...change, status: existing.status, hunkStatuses: existing.hunkStatuses });
			} else {
				merged.set(path, change);
			}
		}
		// Entries in current but NOT in incoming are dropped (removed by revert)

		useStore.getState().loadPendingChanges(merged);
	}, [agentSessionId, agentPendingChanges]);

	// Eagerly check if there's a session to restore so the loading indicator
	// renders on the very first frame, avoiding a flash of the welcome screen.
	const [isRestoringSession, setIsRestoringSession] = useState(() => {
		const currentSession = agentState?.currentSession;
		return !currentSession && !!getActiveSessionId(projectId);
	});

	useEffect(() => {
		if (hasRestoredReference.current) return;
		hasRestoredReference.current = true;

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
