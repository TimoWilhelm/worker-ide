import { useQuery } from '@tanstack/react-query';

import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';

import type { GitCommitEntry } from '@shared/types';

interface UseGitLogOptions {
	projectId: string;
	enabled?: boolean;
	depth?: number;
	reference?: string;
}
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
				await throwApiError(response, 'Failed to fetch git log');
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
