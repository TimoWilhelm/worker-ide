import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toast } from '@/components/ui/toast-store';
import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { createSaveOperationId, enqueueSave, removeQueuedSaveForPath } from '@/lib/save-queue';
import { useStore } from '@/lib/store';

interface UseFileContentOptions {
	projectId: string;
	path: string | undefined;
	enabled?: boolean;
}

interface FileContent {
	path: string;
	content: string;
}

export const FILE_CONTENT_STALE_TIME = 1000 * 60 * 5;
export const FILE_CONTENT_GC_TIME = 1000 * 60 * 30;

const saveSequences = new Map<string, number>();

function saveSequenceKey(projectId: string, path: string): string {
	return `${projectId}:${path}`;
}

export async function fetchFileContent(projectId: string, path: string): Promise<FileContent> {
	const api = createApiClient(projectId);
	const response = await api.file.$get({ query: { path } });

	if (!response.ok) {
		await throwApiError(response, 'Failed to load file');
	}

	const data: FileContent = await response.json();
	return data;
}

export function useFileContent({ projectId, path, enabled = true }: UseFileContentOptions) {
	const queryClient = useQueryClient();
	const api = createApiClient(projectId);

	// Query for fetching file content
	const query = useQuery({
		queryKey: ['file', projectId, path],
		queryFn: async () => {
			if (!path) throw new Error('No path provided');
			return fetchFileContent(projectId, path);
		},
		enabled: enabled && !!path,
		staleTime: FILE_CONTENT_STALE_TIME,
		gcTime: FILE_CONTENT_GC_TIME,
	});

	// Mutation for saving file content
	const saveMutation = useMutation({
		mutationFn: async ({ path: filePath, content }: { path: string; content: string }) => {
			const response = await api.file.$put({
				json: { path: filePath, content },
			});

			if (!response.ok) {
				await throwApiError(response, 'Failed to save file');
			}

			return response.json();
		},
		onMutate: async (variables) => {
			const queryKey = ['file', projectId, variables.path];
			const sequenceKey = saveSequenceKey(projectId, variables.path);
			const sequence = (saveSequences.get(sequenceKey) ?? 0) + 1;
			saveSequences.set(sequenceKey, sequence);
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData<FileContent>(queryKey);
			queryClient.setQueryData(queryKey, {
				path: variables.path,
				content: variables.content,
			});
			return { previous, sequence, operationId: createSaveOperationId() };
		},
		onSuccess: (_data, variables, context) => {
			const sequenceKey = saveSequenceKey(projectId, variables.path);
			if (saveSequences.get(sequenceKey) === context.sequence) {
				removeQueuedSaveForPath(projectId, variables.path);
			}

			queryClient.setQueryData(['file', projectId, variables.path], {
				path: variables.path,
				content: variables.content,
			});
		},
		onError: (_error, variables, context) => {
			enqueueSave({
				projectId,
				path: variables.path,
				content: variables.content,
				operationId: context?.operationId ?? createSaveOperationId(),
			});

			const sequenceKey = saveSequenceKey(projectId, variables.path);
			const storeState = useStore.getState();
			const isActiveDirtyFile = storeState.activeFile === variables.path && storeState.unsavedChanges.get(variables.path) === true;
			if (context && saveSequences.get(sequenceKey) === context.sequence && !isActiveDirtyFile) {
				if (context.previous) {
					queryClient.setQueryData(['file', projectId, variables.path], context.previous);
				} else {
					queryClient.removeQueries({ queryKey: ['file', projectId, variables.path], exact: true });
				}
			}

			const fileName = variables.path.split('/').pop() ?? variables.path;
			toast.error(`Could not save ${fileName}. Your changes were queued and will sync when your connection recovers.`);
		},
	});

	// Convenience save function (returns a promise so callers can handle success/failure)
	const saveFile = useCallback(
		async (content: string) => {
			if (!path) return;
			await saveMutation.mutateAsync({ path, content });
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
