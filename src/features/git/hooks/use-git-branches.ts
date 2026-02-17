/**
 * useGitBranches Hook
 *
 * Fetches branch list and syncs to the Zustand store.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { createApiClient } from '@/lib/api-client';
import { useStore } from '@/lib/store';

import type { GitBranchInfo } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface UseGitBranchesOptions {
	projectId: string;
	enabled?: boolean;
}

interface BranchesResponse {
	branches: GitBranchInfo[];
	current: string | undefined;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for fetching and managing git branches.
 * Syncs branch list to the store.
 */
export function useGitBranches({ projectId, enabled = true }: UseGitBranchesOptions) {
	const api = createApiClient(projectId);
	const { setGitBranches } = useStore();

	const query = useQuery({
		queryKey: ['git-branches', projectId],
		queryFn: async (): Promise<BranchesResponse> => {
			const response = await api.git.branches.$get({});
			if (!response.ok) {
				throw new Error('Failed to fetch branches');
			}
			const data = await response.json();
			const current = 'current' in data && typeof data.current === 'string' ? data.current : undefined;
			return { branches: data.branches, current };
		},
		enabled,
		staleTime: 1000 * 10,
	});

	// Sync to store
	useEffect(() => {
		if (query.data) {
			setGitBranches(query.data.branches);
		}
	}, [query.data, setGitBranches]);

	return {
		branches: query.data?.branches ?? [],
		currentBranch: query.data?.current,
		isLoading: query.isLoading,
		isError: query.isError,
		refetch: query.refetch,
	};
}
