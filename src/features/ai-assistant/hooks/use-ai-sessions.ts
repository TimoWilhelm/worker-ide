/**
 * useAiSessions Hook
 *
 * Manages AI session persistence — listing, loading, and saving sessions.
 * Sessions include conversation history, message-to-snapshot mappings,
 * and pending file changes so that inline diffs survive page refreshes.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { fetchLatestDebugLogId, listAiSessions, loadAiSession, loadProjectPendingChanges, revertAiSession } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { sleep } from '@/lib/utils';

import { messageModesRecordToMap, pendingChangesRecordToMap, snapshotsRecordToMap } from '../lib/session-serializers';

import type { ToolErrorInfo, ToolMetadataInfo } from '@shared/types';

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
		// Ignore storage errors (e.g. private browsing)
	}
}

// =============================================================================
// Hook
// =============================================================================

export function useAiSessions({
	projectId,
	onSessionLoaded,
}: {
	projectId: string;
	/** Called after a session is loaded (explicit or auto-restore) with persisted metadata.
	 *  The panel uses this to populate its toolMetadata and toolErrors refs/state. */
	onSessionLoaded?: (data: { toolMetadata?: Record<string, ToolMetadataInfo>; toolErrors?: Record<string, ToolErrorInfo> }) => void;
}) {
	const queryClient = useQueryClient();
	const { setSavedSessions, loadSession, setDebugLogId } = useStore();

	// Preserve the original creation timestamp across session loads
	const createdAtReference = useRef<number | undefined>(undefined);

	// =========================================================================
	// List sessions
	// =========================================================================

	const sessionsQuery = useQuery({
		queryKey: ['ai-sessions', projectId],
		queryFn: () => listAiSessions(projectId),
		staleTime: 1000 * 30,
	});

	// Sync sessions list and running session IDs to the store
	useEffect(() => {
		if (sessionsQuery.data) {
			setSavedSessions(sessionsQuery.data);
			// Derive running session IDs from the sessions list
			const runningIds = new Set(sessionsQuery.data.filter((session) => session.isRunning).map((session) => session.id));
			useStore.getState().setRunningSessionIds(runningIds);
		}
	}, [sessionsQuery.data, setSavedSessions]);

	// =========================================================================
	// Load a session from the backend
	// =========================================================================

	const loadSessionMutation = useMutation({
		mutationFn: (targetSessionId: string) => loadAiSession(projectId, targetSessionId),
		onSuccess: (data) => {
			if (!data) return;
			const restoredSnapshots = snapshotsRecordToMap(data.messageSnapshots);
			const restoredModes = messageModesRecordToMap(data.messageModes);
			createdAtReference.current = data.createdAt;
			// AiSession.history is unknown[] for wire-format flexibility.
			// Cast to UIMessage[] — the store expects UIMessage[].
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- wire format cast
			loadSession(data.history as any[], data.id, restoredSnapshots, data.contextTokensUsed, restoredModes);
			// Restore persisted tool metadata and errors so loaded sessions render
			// the same rich UI (edit stats, line counts, error labels) as live ones.
			onSessionLoaded?.({ toolMetadata: data.toolMetadata, toolErrors: data.toolErrors });
			// Restore the latest debug log download button for this session
			void fetchLatestDebugLogId(projectId, data.id).then((logId) => {
				if (logId) setDebugLogId(logId);
			});
		},
	});

	// =========================================================================
	// Auto-restore the active session on mount
	// =========================================================================

	const hasRestoredReference = useRef(false);

	// Eagerly check if there's a session to restore so the loading indicator
	// renders on the very first frame, avoiding a flash of the welcome screen.
	const [isRestoringSession, setIsRestoringSession] = useState(
		() => useStore.getState().history.length === 0 && !!getActiveSessionId(projectId),
	);

	useEffect(() => {
		if (hasRestoredReference.current) return;
		hasRestoredReference.current = true;

		// Load project-level pending changes (independent of session)
		void loadProjectPendingChanges(projectId)
			.then((pendingRecord) => {
				const pendingMap = pendingChangesRecordToMap(pendingRecord);
				if (pendingMap.size > 0) {
					useStore.getState().loadPendingChanges(pendingMap);
				}
			})
			.catch((error: unknown) => {
				console.error('Failed to load pending changes:', error);
			});

		const { history } = useStore.getState();
		// Only attempt restore when there is no in-memory history.
		// The active session ID is stored in localStorage scoped per project,
		// so each project resolves its own last-active session.
		if (history.length === 0) {
			const activeId = getActiveSessionId(projectId);
			if (!activeId) return;

			void (async () => {
				const maxRetries = 3;
				let lastError: unknown;

				for (let attempt = 0; attempt < maxRetries; attempt++) {
					try {
						if (attempt > 0) await sleep(1000 * attempt);

						const data = await loadAiSession(projectId, activeId);

						if (!data) {
							// 404 — session genuinely deleted. Clear the stale pointer.
							setActiveSessionId(projectId, undefined);
							setIsRestoringSession(false);
							return;
						}

						const restoredSnapshots = snapshotsRecordToMap(data.messageSnapshots);
						const restoredModes = messageModesRecordToMap(data.messageModes);
						createdAtReference.current = data.createdAt;
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- wire format cast
						loadSession(data.history as any[], data.id, restoredSnapshots, data.contextTokensUsed, restoredModes);
						// Restore persisted tool metadata and errors
						onSessionLoaded?.({ toolMetadata: data.toolMetadata, toolErrors: data.toolErrors });
						// Restore the latest debug log download button for this session
						void fetchLatestDebugLogId(projectId, data.id).then((logId) => {
							if (logId) setDebugLogId(logId);
						});

						setIsRestoringSession(false);
						return;
					} catch (error: unknown) {
						lastError = error;
					}
				}

				// All retries exhausted — show error but do NOT clear localStorage.
				// The session still exists server-side; the user can retry by refreshing.
				console.error('Failed to restore AI session after retries:', lastError);
				toast.error('Failed to restore your previous session. Try refreshing the page.');
				setIsRestoringSession(false);
			})();
		}
	}, [projectId, loadSession, setDebugLogId, onSessionLoaded]);

	// =========================================================================
	// Revert session (server-side truncation — the DO owns all session mutations)
	// =========================================================================

	const revertSession = useCallback(
		async (messageIndex: number) => {
			const { sessionId } = useStore.getState();
			if (!sessionId) return;

			try {
				await revertAiSession(projectId, sessionId, messageIndex);

				// Full revert (all messages removed) — clear client-side pointers
				if (messageIndex === 0) {
					setActiveSessionId(projectId, undefined);
					useStore.setState({ sessionId: undefined });
				}

				await queryClient.invalidateQueries({ queryKey: ['ai-sessions', projectId] });
			} catch (error) {
				console.error('Failed to revert AI session:', error);
			}
		},
		[projectId, queryClient],
	);

	// =========================================================================
	// Public API
	// =========================================================================

	return {
		/** List of saved sessions (from React Query) */
		savedSessions: sessionsQuery.data ?? [],
		/** Whether the sessions list is loading */
		isLoadingSessions: sessionsQuery.isLoading,
		/** Load a specific session by ID */
		handleLoadSession: loadSessionMutation.mutate,
		/** Whether a session is currently being loaded */
		isLoadingSession: loadSessionMutation.isPending,
		/** Whether the auto-restore of the last active session is in progress */
		isRestoringSession,
		/** Revert a session to a given message index (server-side truncation).
		 *  The DO truncates history, prunes snapshots, and sets revertedAt. */
		revertSession,
	};
}
