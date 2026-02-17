/**
 * useGitStatus Hook
 *
 * Fetches git status and syncs it to the Zustand store.
 * Auto-refreshes when a git-status-changed WebSocket message arrives.
 */

import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { createApiClient } from '@/lib/api-client';
import { useStore } from '@/lib/store';

import type { GitStatusEntry } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface UseGitStatusOptions {
	projectId: string;
	enabled?: boolean;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for fetching and managing git status.
 * Syncs status entries and initialization state to the store.
 */
export function useGitStatus({ projectId, enabled = true }: UseGitStatusOptions) {
	const api = createApiClient(projectId);
	const { setGitStatus, setGitStatusLoading, setGitInitialized } = useStore();

	const query = useQuery({
		queryKey: ['git-status', projectId],
		queryFn: async (): Promise<{ entries: GitStatusEntry[]; initialized: boolean }> => {
			const response = await api.git.status.$get({});
			if (!response.ok) {
				throw new Error('Failed to fetch git status');
			}
			const data: { entries: GitStatusEntry[]; initialized: boolean } = await response.json();
			return data;
		},
		enabled,
		staleTime: 1000 * 5,
	});

	// Sync to store
	useEffect(() => {
		setGitStatusLoading(query.isLoading);
	}, [query.isLoading, setGitStatusLoading]);

	useEffect(() => {
		if (query.data) {
			setGitStatus(query.data.entries);
			setGitInitialized(query.data.initialized);
		}
	}, [query.data, setGitStatus, setGitInitialized]);

	return {
		entries: query.data?.entries ?? [],
		initialized: query.data?.initialized ?? false,
		isLoading: query.isLoading,
		isError: query.isError,
		refetch: query.refetch,
	};
}

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
				throw new Error('Failed to fetch git status');
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
