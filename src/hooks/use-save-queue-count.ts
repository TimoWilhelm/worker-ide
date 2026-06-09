import { useSyncExternalStore } from 'react';

import { getQueuedSaveCount, subscribeSaveQueue } from '@/lib/save-queue';

export function useSaveQueueCount(projectId?: string): number {
	return useSyncExternalStore(
		subscribeSaveQueue,
		() => getQueuedSaveCount(projectId),
		() => 0,
	);
}
