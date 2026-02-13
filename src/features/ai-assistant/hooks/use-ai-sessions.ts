/**
 * useAiSessions Hook
 *
 * Manages AI session persistence — listing, loading, and saving sessions.
 * Sessions include conversation history and message-to-snapshot mappings
 * so that revert buttons survive page refreshes.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { listAiSessions, loadAiSession, saveAiSession } from '@/lib/api-client';
import { useStore } from '@/lib/store';

import type { AgentMessage } from '@shared/types';

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
 */
function deriveLabel(history: AgentMessage[]): string {
	const firstUserMessage = history.find((message) => message.role === 'user');
	if (!firstUserMessage) return 'New chat';

	const text = firstUserMessage.content
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
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
	const { history, sessionId, messageSnapshots, setSavedSessions, setSessionId, loadSession } = useStore();

	// Track whether a save is already in flight to avoid overlapping saves
	const isSavingReference = useRef(false);

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
			loadSession(data.history, data.id, restoredSnapshots);
		},
	});

	// =========================================================================
	// Save current session to the backend
	// =========================================================================

	const saveCurrentSession = useCallback(async () => {
		if (history.length === 0) return;
		if (isSavingReference.current) return;

		isSavingReference.current = true;
		try {
			// Generate a session ID if this is a new conversation
			let currentSessionId = sessionId;
			if (!currentSessionId) {
				currentSessionId = generateSessionId();
				setSessionId(currentSessionId);
			}

			await saveAiSession(projectId, {
				id: currentSessionId,
				label: deriveLabel(history),
				createdAt: Date.now(),
				history,
				messageSnapshots: snapshotsMapToRecord(messageSnapshots),
			});

			// Refresh the sessions list
			await queryClient.invalidateQueries({ queryKey: ['ai-sessions', projectId] });
		} catch (error) {
			console.error('Failed to save AI session:', error);
		} finally {
			isSavingReference.current = false;
		}
	}, [history, sessionId, messageSnapshots, projectId, setSessionId, queryClient]);

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
