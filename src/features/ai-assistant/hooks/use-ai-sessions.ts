import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { isAgentState } from '@/features/ai-assistant/lib/agent-state';
import { useStore } from '@/lib/store';

import type { AgentState } from '@shared/agent-state';
import type { PendingFileChange } from '@shared/types';
function activeSessionKey(projectId: string): string {
	return `worker-ide-active-session:${projectId}`;
}
function getActiveSessionId(projectId: string): string | undefined {
	try {
		return localStorage.getItem(activeSessionKey(projectId)) ?? undefined;
	} catch {
		return undefined;
	}
}
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

interface AgentHandle {
	state: unknown;
	call: <T = unknown>(method: string, arguments_?: unknown[]) => Promise<T>;
}

export function useAiSessions({ projectId, agent }: { projectId: string; agent: AgentHandle }) {
	// Session list comes from agent.state.sessions (auto-synced)
	const rawState = agent.state;
	const agentState: AgentState | undefined = isAgentState(rawState) ? rawState : undefined;
	const savedSessions = agentState?.sessions ?? [];
	const [sessionSearchQuery, setSessionSearchQuery] = useState('');
	const [searchedSessionIds, setSearchedSessionIds] = useState<string[] | undefined>();
	const displaySessions = sessionSearchQuery.trim()
		? savedSessions.filter((session) => searchedSessionIds?.includes(session.id))
		: savedSessions;

	useEffect(() => {
		if (!sessionSearchQuery.trim()) {
			return;
		}

		let cancelled = false;
		void agent
			.call<Array<{ sessionId: string; role: string; content: string }>>('searchSessions', [sessionSearchQuery.trim(), 20])
			.then((results) => {
				if (cancelled) return;
				setSearchedSessionIds([...new Set(results.map((result) => result.sessionId))]);
			})
			.catch(() => {
				if (cancelled) return;
				setSearchedSessionIds([]);
			});

		return () => {
			cancelled = true;
		};
	}, [agent, sessionSearchQuery]);

	// =========================================================================
	// Load a session via Agent RPC
	// =========================================================================

	const [isLoadingSession, setIsLoadingSession] = useState(false);

	const handleLoadSession = useCallback(
		(targetSessionId: string) => {
			setIsLoadingSession(true);
			void agent.call('loadSession', [targetSessionId]).then(
				() => {
					setIsLoadingSession(false);
				},
				() => {
					setIsLoadingSession(false);
					toast.error('Could not load the session. Please try again.');
				},
			);
		},
		[agent],
	);

	// =========================================================================
	// Rename a session via Agent RPC
	// =========================================================================

	const handleRenameSession = useCallback(
		async (targetSessionId: string, newTitle: string): Promise<boolean> => {
			try {
				await agent.call('renameSession', [targetSessionId, newTitle]);
				return true;
			} catch {
				toast.error('Could not rename the session. Please try again.');
				return false;
			}
		},
		[agent],
	);

	// =========================================================================
	// Delete a session via Agent RPC
	// =========================================================================

	const handleDeleteSession = useCallback(
		async (targetSessionId: string): Promise<boolean> => {
			try {
				await agent.call('deleteSession', [projectId, targetSessionId]);
				setActiveSessionId(projectId, undefined);
				return true;
			} catch {
				toast.error('Could not delete the session. Please try again.');
				return false;
			}
		},
		[agent, projectId],
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

		// Wait for the Agents SDK to sync state before deciding whether to
		// call loadSession. On page refresh, agentState starts as undefined
		// (SDK hasn't connected yet). If we call loadSession before state
		// arrives, it overwrites the live in-memory streaming state on the
		// DO with stale DB data, losing mid-turn messages.
		if (!agentState) return;

		hasRestoredReference.current = true;

		const currentSession = agentState.currentSession;
		if (currentSession) {
			queueMicrotask(() => setIsRestoringSession(false));
		} else {
			const activeId = getActiveSessionId(projectId);
			if (!activeId) {
				queueMicrotask(() => setIsRestoringSession(false));
				return;
			}

			void agent.call('loadSession', [activeId]).then(
				() => {
					setIsRestoringSession(false);
				},
				() => {
					// Allow the effect to retry on the next agentState change so a
					// transient network hiccup doesn't permanently prevent restore.
					hasRestoredReference.current = false;
					setIsRestoringSession(false);
				},
			);
		}
	}, [projectId, agent, agentState]);

	return {
		savedSessions: displaySessions,
		handleLoadSession,
		handleRenameSession,
		handleDeleteSession,
		sessionSearchQuery,
		setSessionSearchQuery,
		isRestoringSession: isRestoringSession || isLoadingSession,
	};
}
