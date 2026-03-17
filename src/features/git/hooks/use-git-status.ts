/**
 * useGitStatus Hook
 *
 * Fetches git status and syncs it to the Zustand store.
 * Auto-refreshes when a git-status-changed WebSocket message arrives.
 */

import { useSuspenseQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { useStore } from '@/lib/store';

import type { GitStatusEntry } from '@shared/types';

// =============================================================================
// Suspense Hook
// =============================================================================

interface UseGitStatusSuspenseOptions {
	projectId: string;
}

/**
 * Suspense-enabled hook for fetching git status.
 * Suspends until the initial status is loaded.
 */
export function useGitStatusSuspense({ projectId }: UseGitStatusSuspenseOptions) {
	const api = createApiClient(projectId);
	const { setGitStatus, setGitInitialized } = useStore();

	const query = useSuspenseQuery({
		queryKey: ['git-status', projectId],
		queryFn: async (): Promise<{ entries: GitStatusEntry[]; initialized: boolean }> => {
			const response = await api.git.status.$get({});
			if (!response.ok) {
				await throwApiError(response, 'Failed to fetch git status');
			}
			const data: { entries: GitStatusEntry[]; initialized: boolean } = await response.json();
			return data;
		},
		staleTime: 1000 * 5,
	});

	// Sync to store
	useEffect(() => {
		setGitStatus(query.data.entries);
		setGitInitialized(query.data.initialized);
	}, [query.data, setGitStatus, setGitInitialized]);

	return {
		entries: query.data.entries,
		initialized: query.data.initialized,
		refetch: query.refetch,
	};
}
