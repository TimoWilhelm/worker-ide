import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { flushProjectSaveQueue } from '@/lib/queued-save-flush';

import { useOnlineStatus } from './use-online-status';

export function useQueuedSaveFlusher(projectId: string): void {
	const isOnline = useOnlineStatus();
	const queryClient = useQueryClient();

	useEffect(() => {
		if (!isOnline) return;

		void flushProjectSaveQueue({ projectId, queryClient });
	}, [isOnline, projectId, queryClient]);
}
