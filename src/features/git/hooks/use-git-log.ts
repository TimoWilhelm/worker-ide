/**
 * useGitLog Hook
 *
 * Fetches commit history for the current branch.
 */

import { useQuery } from '@tanstack/react-query';

import { createApiClient } from '@/lib/api-client';

import type { GitCommitEntry } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface UseGitLogOptions {
	projectId: string;
	enabled?: boolean;
	/** Max number of commits to fetch (default 50) */
	depth?: number;
	/** Ref to start from (default HEAD) */
	reference?: string;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for fetching git commit history.
 */
export function useGitLog({ projectId, enabled = true, depth = 50, reference }: UseGitLogOptions) {
	const api = createApiClient(projectId);

	const query = useQuery({
		queryKey: ['git-log', projectId, reference, depth],
		queryFn: async (): Promise<GitCommitEntry[]> => {
			const queryParameters: Record<string, string> = {};
			if (reference) {
				queryParameters.reference = reference;
			}
			if (depth) {
				queryParameters.depth = String(depth);
			}

			const response = await api.git.log.$get({ query: queryParameters });
			if (!response.ok) {
				throw new Error('Failed to fetch git log');
			}
			const data: { commits: GitCommitEntry[] } = await response.json();
			return data.commits;
		},
		enabled,
		staleTime: 1000 * 10,
	});

	return {
		commits: query.data ?? [],
		isLoading: query.isLoading,
		isError: query.isError,
		refetch: query.refetch,
	};
}
