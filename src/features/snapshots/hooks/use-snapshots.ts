/**
 * useSnapshots Hook
 *
 * Hook for loading and managing project snapshots.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { createApiClient } from '@/lib/api-client';
import { useStore } from '@/lib/store';

import type { SnapshotMetadata, SnapshotSummary } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface UseSnapshotsOptions {
	projectId: string;
	enabled?: boolean;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for loading and managing snapshots.
 */
export function useSnapshots({ projectId, enabled = true }: UseSnapshotsOptions) {
	const queryClient = useQueryClient();
	const api = createApiClient(projectId);
	const { setSnapshots } = useStore();

	// List all snapshots
	const listQuery = useQuery({
		queryKey: ['snapshots', projectId],
		queryFn: async () => {
			const response = await api.snapshots.$get({});
			if (!response.ok) {
				throw new Error('Failed to load snapshots');
			}
			const data: { snapshots: SnapshotSummary[] } = await response.json();
			return data.snapshots;
		},
		enabled,
		staleTime: 1000 * 30,
	});

	// Get snapshot detail
	const getSnapshotDetail = async (snapshotId: string): Promise<SnapshotMetadata | undefined> => {
		const response = await api.snapshot[':id'].$get({
			param: { id: snapshotId },
		});
		if (!response.ok) return undefined;
		const data: { snapshot: SnapshotMetadata } = await response.json();
		return data.snapshot;
	};

	// Revert entire snapshot
	const revertSnapshotMutation = useMutation({
		mutationFn: async (snapshotId: string) => {
			const response = await api.snapshot[':id'].revert.$post({
				param: { id: snapshotId },
			});
			if (!response.ok) {
				throw new Error('Failed to revert snapshot');
			}
			return response.json();
		},
		onSuccess: async () => {
			// Force refetch (not just invalidate) so files that the HMR hook
			// skips (e.g. the active editor file) still get fresh content.
			await queryClient.refetchQueries({ queryKey: ['files', projectId] });
			await queryClient.refetchQueries({ queryKey: ['file', projectId] });
			// Also refresh the snapshot list itself
			await queryClient.invalidateQueries({ queryKey: ['snapshots', projectId] });
		},
	});

	// Revert a single file from a snapshot
	const revertFileMutation = useMutation({
		mutationFn: async ({ path, snapshotId }: { path: string; snapshotId: string }) => {
			const response = await api.snapshot['revert-file'].$post({
				json: { path, snapshotId },
			});
			if (!response.ok) {
				throw new Error('Failed to revert file');
			}
			return response.json();
		},
		onSuccess: async () => {
			await queryClient.refetchQueries({ queryKey: ['files', projectId] });
			await queryClient.refetchQueries({ queryKey: ['file', projectId] });
			await queryClient.invalidateQueries({ queryKey: ['snapshots', projectId] });
		},
	});

	// Sync to store via useEffect to avoid state updates during render
	useEffect(() => {
		if (listQuery.data) {
			setSnapshots(listQuery.data);
		}
	}, [listQuery.data, setSnapshots]);

	return {
		// State
		snapshots: listQuery.data ?? [],
		isLoading: listQuery.isLoading,
		isError: listQuery.isError,

		// Actions
		refetch: listQuery.refetch,
		getSnapshotDetail,

		// Mutations
		revertSnapshotAsync: revertSnapshotMutation.mutateAsync,
		revertFile: revertFileMutation.mutate,
		revertFileAsync: revertFileMutation.mutateAsync,
		isReverting: revertSnapshotMutation.isPending || revertFileMutation.isPending,
	};
}
