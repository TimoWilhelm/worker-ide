import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { isAgentState } from '@/features/ai-assistant/lib/agent-state';
import { useStore } from '@/lib/store';

import type { AgentConnectionState } from '../components/agent-runtime-context';
import type { AgentState } from '@shared/agent-state';
import type { PendingFileChange, AiSession } from '@shared/types';
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

type SessionLoadPhase = 'idle' | 'awaiting-agent-state' | 'loading-saved-session';
type SessionLoadResult = { status: 'loaded'; session: AiSession } | { status: 'missing' } | { status: 'error' };

export function useAiSessions({
	projectId,
	agent,
	agentConnectionState,
}: {
	projectId: string;
	agent: AgentHandle;
	agentConnectionState: AgentConnectionState;
}) {
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
	const [sessionLoadPhase, setSessionLoadPhase] = useState<SessionLoadPhase>(() => {
		const currentSession = agentState?.currentSession;
		return !currentSession && getActiveSessionId(projectId) ? 'awaiting-agent-state' : 'idle';
	});

	const updateSessionLoadPhase = useCallback((nextPhase: SessionLoadPhase) => {
		queueMicrotask(() => {
			setSessionLoadPhase((currentPhase) => (currentPhase === nextPhase ? currentPhase : nextPhase));
		});
	}, []);

	const loadSessionById = useCallback(
		async (targetSessionId: string, reason: 'manual' | 'restore'): Promise<SessionLoadResult> => {
			if (reason === 'manual') {
				setIsLoadingSession(true);
			} else {
				updateSessionLoadPhase('loading-saved-session');
			}

			try {
				const session = await agent.call<AiSession | undefined>('loadSession', [targetSessionId]);
				if (!session) {
					if (getActiveSessionId(projectId) === targetSessionId) {
						setActiveSessionId(projectId, undefined);
					}
					if (reason === 'manual') {
						toast.error('This session is no longer available.');
					}
					return { status: 'missing' };
				}

				setActiveSessionId(projectId, session.id);
				return { status: 'loaded', session };
			} catch {
				if (reason === 'manual') {
					toast.error('Could not load the session. Please try again.');
				}
				return { status: 'error' };
			} finally {
				if (reason === 'manual') {
					setIsLoadingSession(false);
				} else {
					updateSessionLoadPhase('idle');
				}
			}
		},
		[agent, projectId, updateSessionLoadPhase],
	);

	const handleLoadSession = useCallback(
		(targetSessionId: string) => {
			void loadSessionById(targetSessionId, 'manual');
		},
		[loadSessionById],
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

	const attemptedRestoreSessionIdReference = useRef<string | undefined>(undefined);

	// Track the last-known session ID so we can distinguish "session genuinely
	// cleared" from "transient undefined during loadSession switch".
	const lastSessionIdReference = useRef(agentState?.currentSession?.sessionId);

	// Sync the authoritative project review queue into the Zustand store.
	// While a session is actively running, overlay its live pending changes so
	// the editor can preview in-flight edits before the turn is persisted.
	const agentSessionId = agentState?.currentSession?.sessionId;
	const agentPendingChanges = agentState?.currentSession?.pendingChanges;
	const authoritativeReviewEntries = agentState?.reviewEntries;
	const isSessionRunning = agentState?.currentSession?.status === 'running';
	const authoritativeReviewSignature = JSON.stringify(authoritativeReviewEntries ?? {});
	const agentPendingChangesSignature = JSON.stringify(agentPendingChanges ?? {});
	useEffect(() => {
		const current = useStore.getState().pendingChanges;
		const merged = new Map<string, PendingFileChange>();

		for (const entry of Object.values(authoritativeReviewEntries ?? {})) {
			merged.set(entry.path, {
				path: entry.path,
				action: entry.action,
				beforeContent: entry.beforeContent,
				afterContent: entry.afterContent,
				snapshotId: entry.snapshotId,
				status: 'pending',
				hunkStatuses: entry.hunkStatuses,
				sessionId: entry.latestSessionId,
				sessionIds: entry.sessionIds,
				reviewId: entry.id,
			});
		}

		if (isSessionRunning && agentPendingChanges) {
			for (const [path, change] of Object.entries(agentPendingChanges)) {
				const existing = merged.get(path);
				merged.set(path, {
					...change,
					sessionId: existing?.sessionId ?? change.sessionId,
					sessionIds: existing?.sessionIds ?? change.sessionIds,
					reviewId: existing?.reviewId,
					hunkStatuses: existing?.hunkStatuses ?? change.hunkStatuses,
				});
			}
		}

		if (merged.size === 0 && agentSessionId === undefined && lastSessionIdReference.current !== undefined) {
			lastSessionIdReference.current = undefined;
			if (current.size > 0) {
				useStore.getState().loadPendingChanges(new Map());
			}
			return;
		}

		lastSessionIdReference.current = agentSessionId;
		useStore.getState().loadPendingChanges(merged);
	}, [
		agentSessionId,
		agentPendingChanges,
		agentPendingChangesSignature,
		authoritativeReviewEntries,
		authoritativeReviewSignature,
		isSessionRunning,
	]);

	useEffect(() => {
		const currentSession = agentState?.currentSession;
		const activeSessionId = getActiveSessionId(projectId);

		if (currentSession) {
			attemptedRestoreSessionIdReference.current = currentSession.sessionId;
			if (activeSessionId !== currentSession.sessionId) {
				setActiveSessionId(projectId, currentSession.sessionId);
			}
			updateSessionLoadPhase('idle');
			return;
		}

		if (!activeSessionId) {
			attemptedRestoreSessionIdReference.current = undefined;
			updateSessionLoadPhase('idle');
			return;
		}

		if (!agentState) {
			updateSessionLoadPhase(agentConnectionState === 'disconnected' ? 'idle' : 'awaiting-agent-state');
			return;
		}

		if (attemptedRestoreSessionIdReference.current === activeSessionId) {
			updateSessionLoadPhase('idle');
			return;
		}

		attemptedRestoreSessionIdReference.current = activeSessionId;
		void loadSessionById(activeSessionId, 'restore').then((result) => {
			if (result.status !== 'loaded') {
				attemptedRestoreSessionIdReference.current = undefined;
			}
		});
	}, [agentConnectionState, agentState, loadSessionById, projectId, updateSessionLoadPhase]);

	const isRestoringSession =
		sessionLoadPhase === 'loading-saved-session' || (sessionLoadPhase === 'awaiting-agent-state' && agentConnectionState === 'connecting');

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
