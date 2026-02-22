/**
 * useAiSessions Hook
 *
 * Manages AI session persistence — listing, loading, and saving sessions.
 * Sessions include conversation history, message-to-snapshot mappings,
 * and pending file changes so that inline diffs survive page refreshes.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { fetchLatestDebugLogId, listAiSessions, loadAiSession, saveAiSession } from '@/lib/api-client';
import { useStore } from '@/lib/store';

import {
	deriveLabel,
	pendingChangesMapToRecord,
	pendingChangesRecordToMap,
	snapshotsMapToRecord,
	snapshotsRecordToMap,
} from '../lib/session-serializers';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Generate a session ID: 16 lowercase hex characters (satisfies the
 * backend schema `^[a-z0-9]+$` with max 32 chars).
 */
function generateSessionId(): string {
	return crypto.randomUUID().replaceAll('-', '').slice(0, 16);
}

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

export function useAiSessions({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const { setSavedSessions, setSessionId, loadSession, setDebugLogId } = useStore();

	// Track whether a save is already in flight to avoid overlapping saves
	const isSavingReference = useRef(false);
	// Preserve the original creation timestamp across saves
	const createdAtReference = useRef<number | undefined>(undefined);

	// =========================================================================
	// List sessions
	// =========================================================================

	const sessionsQuery = useQuery({
		queryKey: ['ai-sessions', projectId],
		queryFn: () => listAiSessions(projectId),
		staleTime: 1000 * 30,
	});

	// Sync sessions list to the store
	useEffect(() => {
		if (sessionsQuery.data) {
			setSavedSessions(sessionsQuery.data);
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
			const restoredPendingChanges = pendingChangesRecordToMap(data.pendingChanges);
			createdAtReference.current = data.createdAt;
			// AiSession.history is unknown[] for wire-format flexibility.
			// Cast to UIMessage[] — the store expects UIMessage[].
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- wire format cast
			loadSession(data.history as any[], data.id, restoredSnapshots, data.contextTokensUsed, restoredPendingChanges);
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

	useEffect(() => {
		if (hasRestoredReference.current) return;
		hasRestoredReference.current = true;

		const { history } = useStore.getState();
		// Only attempt restore when there is no in-memory history.
		// The active session ID is stored in localStorage scoped per project,
		// so each project resolves its own last-active session.
		if (history.length === 0) {
			const activeId = getActiveSessionId(projectId);
			if (!activeId) return;
			void loadAiSession(projectId, activeId).then((data) => {
				if (!data) {
					// Session file was deleted — clear the stale pointer.
					setActiveSessionId(projectId, undefined);
					return;
				}
				const restoredSnapshots = snapshotsRecordToMap(data.messageSnapshots);
				const restoredPendingChanges = pendingChangesRecordToMap(data.pendingChanges);
				createdAtReference.current = data.createdAt;
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- wire format cast
				loadSession(data.history as any[], data.id, restoredSnapshots, data.contextTokensUsed, restoredPendingChanges);
				// Restore the latest debug log download button for this session
				void fetchLatestDebugLogId(projectId, data.id).then((logId) => {
					if (logId) setDebugLogId(logId);
				});
			});
		}
	}, [projectId, loadSession, setSessionId, setDebugLogId]);

	// =========================================================================
	// Save current session to the backend (used only for client-only operations
	// like revert — normal streaming persistence is handled server-side)
	// =========================================================================

	const saveCurrentSession = useCallback(async () => {
		// Read directly from the store so we always get the latest state,
		// even when called from a microtask before React re-renders.
		const { history, sessionId, messageSnapshots, contextTokensUsed, pendingChanges } = useStore.getState();

		if (history.length === 0) return;
		if (isSavingReference.current) return;

		isSavingReference.current = true;
		try {
			// Generate a session ID if this is a new conversation
			let currentSessionId = sessionId;
			const isNewSession = !currentSessionId;
			if (!currentSessionId) {
				currentSessionId = generateSessionId();
				createdAtReference.current = Date.now();
			}

			await saveAiSession(projectId, {
				id: currentSessionId,
				label: deriveLabel(history),
				createdAt: createdAtReference.current ?? Date.now(),
				history,
				messageSnapshots: snapshotsMapToRecord(messageSnapshots),
				contextTokensUsed: contextTokensUsed > 0 ? contextTokensUsed : undefined,
				pendingChanges: pendingChangesMapToRecord(pendingChanges),
			});

			// Only persist the session ID after the backend confirms the save,
			// so we never rehydrate a sessionId that doesn't exist on disk.
			if (isNewSession) {
				setSessionId(currentSessionId);
				// Persist the active session pointer in localStorage (scoped
				// per project) so it survives page reloads.
				setActiveSessionId(projectId, currentSessionId);
			}

			// Refresh the sessions list
			await queryClient.invalidateQueries({ queryKey: ['ai-sessions', projectId] });
		} catch (error) {
			console.error('Failed to save AI session:', error);
		} finally {
			isSavingReference.current = false;
		}
	}, [projectId, setSessionId, queryClient]);

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
		/** Save the current session state to the backend (revert-only — streaming persistence is server-side) */
		saveCurrentSession,
	};
}
