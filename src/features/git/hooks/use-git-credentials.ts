import { useMutation, useQuery } from '@tanstack/react-query';

import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';

interface UseGitRemoteOptions {
	projectId: string;
	enabled?: boolean;
}

interface GitRemoteResponse {
	cloneUrl: string;
	repoId: string;
}

interface GitCredentialsResponse {
	token: string;
	expiresAt: string;
	cloneUrl: string;
	username: string;
}
export function useGitRemote({ projectId, enabled = true }: UseGitRemoteOptions) {
	const api = createApiClient(projectId);

	const query = useQuery({
		queryKey: ['git-remote', projectId],
		queryFn: async (): Promise<GitRemoteResponse> => {
			const response = await api.git.remote.$get({});
			if (!response.ok) {
				await throwApiError(response, 'Failed to fetch git remote');
			}
			return response.json();
		},
		enabled,
		staleTime: 1000 * 60 * 5,
	});

	return {
		cloneUrl: query.data?.cloneUrl,
		repoId: query.data?.repoId,
		isLoading: query.isLoading,
		isError: query.isError,
	};
}
export function useGenerateGitCredentials({ projectId }: { projectId: string }) {
	const api = createApiClient(projectId);

	return useMutation({
		mutationFn: async (): Promise<GitCredentialsResponse> => {
			const response = await api.git.credentials.$post({});
			if (!response.ok) {
				await throwApiError(response, 'Failed to generate git credentials');
			}
			return response.json();
		},
	});
}
