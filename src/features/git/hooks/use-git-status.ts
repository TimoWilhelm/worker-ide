import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { useStore } from '@/lib/store';

import type { GitStatusEntry } from '@shared/types';

interface UseGitStatusSuspenseOptions {
	projectId: string;
}

interface GitStatusResult {
	entries: GitStatusEntry[];
	initialized: boolean;
}

const GIT_STATUS_STALE_TIME = 1000 * 5;

async function fetchGitStatus(projectId: string): Promise<GitStatusResult> {
	const api = createApiClient(projectId);
	const response = await api.git.status.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch git status');
	}
	const data: GitStatusResult = await response.json();
	return data;
}

/**
 * Non-suspense, always-on git status loader. Fetches git status in the
 * background (regardless of which sidebar view is active) and syncs it into the
 * store so the file tree icons stay accurate. Loading never blocks rendering;
 * the rest of the app stays interactive while the request is in flight.
 *
 * Shares the same query key as {@link useGitStatusSuspense}, so the Git panel
 * reuses this cached result instead of issuing a duplicate request.
 */
export function useGitStatusBackgroundLoader({ projectId }: UseGitStatusSuspenseOptions) {
	const setGitStatus = useStore((state) => state.setGitStatus);
	const setGitInitialized = useStore((state) => state.setGitInitialized);

	const query = useQuery({
		queryKey: ['git-status', projectId],
		queryFn: () => fetchGitStatus(projectId),
		staleTime: GIT_STATUS_STALE_TIME,
	});

	useEffect(() => {
		if (!query.data) return;
		setGitStatus(query.data.entries);
		setGitInitialized(query.data.initialized);
	}, [query.data, setGitStatus, setGitInitialized]);
}

/**
 * Suspense-enabled hook for fetching git status.
 * Suspends until the initial status is loaded.
 */
export function useGitStatusSuspense({ projectId }: UseGitStatusSuspenseOptions) {
	const { setGitStatus, setGitInitialized } = useStore();

	const query = useSuspenseQuery({
		queryKey: ['git-status', projectId],
		queryFn: () => fetchGitStatus(projectId),
		staleTime: GIT_STATUS_STALE_TIME,
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
