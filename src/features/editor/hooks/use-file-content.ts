/**
 * useFileContent Hook
 *
 * Hook for loading and saving file content via API.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { createApiClient } from '@/lib/api-client';

// =============================================================================
// Types
// =============================================================================

interface UseFileContentOptions {
	projectId: string;
	path: string | undefined;
	enabled?: boolean;
}

interface FileContent {
	path: string;
	content: string;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for loading and saving file content.
 */
export function useFileContent({ projectId, path, enabled = true }: UseFileContentOptions) {
	const queryClient = useQueryClient();
	const api = createApiClient(projectId);

	// Query for fetching file content
	const query = useQuery({
		queryKey: ['file', projectId, path],
		queryFn: async () => {
			if (!path) throw new Error('No path provided');

			const response = await api.file.$get({ query: { path } });

			if (!response.ok) {
				throw new Error('Failed to load file');
			}

			const data: FileContent = await response.json();
			return data;
		},
		enabled: enabled && !!path,
		staleTime: 0, // Always fetch fresh content
	});

	// Mutation for saving file content
	const saveMutation = useMutation({
		mutationFn: async ({ path: filePath, content }: { path: string; content: string }) => {
			const response = await api.file.$put({
				json: { path: filePath, content },
			});

			if (!response.ok) {
				throw new Error('Failed to save file');
			}

			return response.json();
		},
		onSuccess: (_data, variables) => {
			// Update the cache with the new content
			queryClient.setQueryData(['file', projectId, variables.path], {
				path: variables.path,
				content: variables.content,
			});
		},
	});

	// Convenience save function
	const saveFile = useCallback(
		(content: string) => {
			if (!path) return;
			saveMutation.mutate({ path, content });
		},
		[path, saveMutation],
	);

	return {
		content: query.data?.content ?? '',
		isLoading: query.isLoading,
		isError: query.isError,
		error: query.error,
		isSaving: saveMutation.isPending,
		saveError: saveMutation.error,
		saveFile,
		refetch: query.refetch,
	};
}

// =============================================================================
// useFileList Hook
// =============================================================================

interface UseFileListOptions {
	projectId: string;
	enabled?: boolean;
}

/**
 * Hook for loading file list.
 */
export function useFileList({ projectId, enabled = true }: UseFileListOptions) {
	const api = createApiClient(projectId);

	return useQuery({
		queryKey: ['files', projectId],
		queryFn: async () => {
			const response = await api.files.$get({});

			if (!response.ok) {
				throw new Error('Failed to load files');
			}

			const data: { files: string[] } = await response.json();
			return data.files;
		},
		enabled,
		staleTime: 1000 * 30, // 30 seconds
	});
}
