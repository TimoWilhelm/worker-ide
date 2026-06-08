import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { flushQueuedSaves } from '@/lib/save-queue';

import type { QueryClient } from '@tanstack/react-query';

interface FlushProjectSaveQueueOptions {
	projectId: string;
	queryClient: QueryClient;
}

export async function flushProjectSaveQueue({ projectId, queryClient }: FlushProjectSaveQueueOptions): Promise<void> {
	await flushQueuedSaves({
		projectId,
		save: async (entry) => {
			const api = createApiClient(entry.projectId);
			const response = await api.file.$put({ json: { path: entry.path, content: entry.content } });
			if (!response.ok) {
				await throwApiError(response, 'Failed to flush queued save');
			}
		},
		onSuccess: (entry) => {
			queryClient.setQueryData(['file', entry.projectId, entry.path], { path: entry.path, content: entry.content });
			void queryClient.invalidateQueries({ queryKey: ['git-status', entry.projectId] });
		},
	});
}
