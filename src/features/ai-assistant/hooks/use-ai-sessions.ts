/**
 * useAiSessions Hook
 *
 * Manages AI session persistence — listing, loading, and saving sessions.
 * Sessions include conversation history and message-to-snapshot mappings
 * so that revert buttons survive page refreshes.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { createApiClient, fetchLatestDebugLogId, listAiSessions, loadAiSession, saveAiSession } from '@/lib/api-client';
import { useStore } from '@/lib/store';

import type { UIMessage } from '@shared/types';

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
 * Derive a session label from the first user message (truncated to 50 chars).
 * UIMessage uses `parts: MessagePart[]` with TextPart { type: 'text', content: string }.
 */
function deriveLabel(history: UIMessage[]): string {
	const firstUserMessage = history.find((message) => message.role === 'user');
	if (!firstUserMessage) return 'New chat';

	const text = firstUserMessage.parts
		.filter((part): part is { type: 'text'; content: string } => part.type === 'text')
		.map((part) => part.content)
		.join(' ')
		.trim();

	return text.length > 50 ? text.slice(0, 50) + '...' : text || 'New chat';
}

/**
 * Convert a Map<number, string> to a JSON-safe Record<string, string>.
 */
function snapshotsMapToRecord(snapshotsMap: Map<number, string>): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [key, value] of snapshotsMap) {
		record[String(key)] = value;
	}
	return record;
}

/**
 * Convert a Record<string, string> back to a Map<number, string>.
 */
function snapshotsRecordToMap(record: Record<string, string> | undefined): Map<number, string> {
	const map = new Map<number, string>();
	if (!record) return map;
	for (const [key, value] of Object.entries(record)) {
		const index = Number(key);
		if (Number.isFinite(index)) {
			map.set(index, value);
		}
	}
	return map;
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
			createdAtReference.current = data.createdAt;
			// AiSession.history is unknown[] for wire-format flexibility.
			// Cast to UIMessage[] — the store expects UIMessage[].
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- wire format cast
			loadSession(data.history as any[], data.id, restoredSnapshots);
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

		const { sessionId, history } = useStore.getState();
		// If we have a persisted sessionId but no in-memory history,
		// reload the session from the backend.
		if (sessionId && history.length === 0) {
			void loadAiSession(projectId, sessionId).then((data) => {
				if (!data) {
					// Session no longer exists on the backend — clear the stale ID
					// so we don't keep retrying on every page load.
					setSessionId(undefined);
					return;
				}
				const restoredSnapshots = snapshotsRecordToMap(data.messageSnapshots);
				createdAtReference.current = data.createdAt;
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- wire format cast
				loadSession(data.history as any[], data.id, restoredSnapshots);
				// Restore the latest debug log download button for this session
				void fetchLatestDebugLogId(projectId, data.id).then((logId) => {
					if (logId) setDebugLogId(logId);
				});
			});
		}
	}, [projectId, loadSession, setSessionId, setDebugLogId]);

	// =========================================================================
	// Save current session to the backend
	// =========================================================================

	const saveCurrentSession = useCallback(async () => {
		// Read directly from the store so we always get the latest state,
		// even when called from a microtask before React re-renders.
		const { history, sessionId, messageSnapshots } = useStore.getState();

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
			});

			// Only persist the session ID after the backend confirms the save,
			// so we never rehydrate a sessionId that doesn't exist on disk.
			if (isNewSession) {
				setSessionId(currentSessionId);
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
	// Save on page unload / tab switch
	// =========================================================================

	const saveCurrentSessionReference = useRef(saveCurrentSession);
	useEffect(() => {
		saveCurrentSessionReference.current = saveCurrentSession;
	}, [saveCurrentSession]);

	useEffect(() => {
		const api = createApiClient(projectId);

		const saveViaBeacon = () => {
			const { history, sessionId, messageSnapshots } = useStore.getState();
			if (history.length === 0 || !sessionId) return;

			const payload = JSON.stringify({
				id: sessionId,
				label: deriveLabel(history),
				createdAt: createdAtReference.current ?? Date.now(),
				history,
				messageSnapshots: snapshotsMapToRecord(messageSnapshots),
			});

			// sendBeacon is fire-and-forget and survives page unload
			const url = api['ai-session'].$url().toString();
			navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
		};

		const handleBeforeUnload = () => saveViaBeacon();
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'hidden') {
				saveViaBeacon();
			}
		};

		globalThis.addEventListener('beforeunload', handleBeforeUnload);
		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			globalThis.removeEventListener('beforeunload', handleBeforeUnload);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [projectId]);

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
		/** Save the current session state to the backend */
		saveCurrentSession,
	};
}
