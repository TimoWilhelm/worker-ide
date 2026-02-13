/**
 * useChangeReview Hook
 *
 * Manages approval/rejection of AI file changes.
 * Approve = keep the change (file already written by AI).
 * Reject = revert the file using the snapshot API.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useSnapshots } from '@/features/snapshots';
import { useStore } from '@/lib/store';

// =============================================================================
// Hook
// =============================================================================

export function useChangeReview({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const { pendingChanges, approveChange, rejectChange, approveAllChanges, rejectAllChanges } = useStore();
	const { revertFile, revertFileAsync, isReverting } = useSnapshots({ projectId });

	// Derive list of pending (unresolved) changes
	const unresolvedChanges = useMemo(() => {
		const result: Array<{ path: string; action: 'create' | 'edit' | 'delete'; snapshotId: string | undefined }> = [];
		for (const [, change] of pendingChanges) {
			if (change.status === 'pending') {
				result.push({ path: change.path, action: change.action, snapshotId: change.snapshotId });
			}
		}
		return result;
	}, [pendingChanges]);

	const pendingCount = unresolvedChanges.length;

	// Whether any pending change has a snapshot to revert to
	const canReject = useMemo(() => {
		for (const change of pendingChanges.values()) {
			if (change.status === 'pending' && change.snapshotId) return true;
		}
		return false;
	}, [pendingChanges]);

	// Approve a single file change (just mark it — file is already written)
	const handleApproveChange = useCallback(
		(path: string) => {
			approveChange(path);
		},
		[approveChange],
	);

	// Reject a single file change (revert via snapshot API)
	const handleRejectChange = useCallback(
		(path: string) => {
			const change = pendingChanges.get(path);
			if (!change) return;

			if (change.snapshotId) {
				revertFile(
					{ path, snapshotId: change.snapshotId },
					{
						onSuccess: () => {
							rejectChange(path);
						},
					},
				);
			} else {
				// No snapshot yet — just mark as rejected
				rejectChange(path);
			}
		},
		[pendingChanges, revertFile, rejectChange],
	);

	// Approve all pending changes
	const handleApproveAll = useCallback(() => {
		approveAllChanges();
	}, [approveAllChanges]);

	// Reject all pending changes (revert each file individually)
	const handleRejectAll = useCallback(async () => {
		// Collect pending files that have a snapshot to revert
		const pendingPaths: Array<{ path: string; snapshotId: string }> = [];
		for (const change of pendingChanges.values()) {
			if (change.status === 'pending' && change.snapshotId) {
				pendingPaths.push({ path: change.path, snapshotId: change.snapshotId });
			}
		}

		// Await all reverts before updating state
		if (pendingPaths.length > 0) {
			await Promise.allSettled(pendingPaths.map(({ path, snapshotId }) => revertFileAsync({ path, snapshotId })));
		}

		// Mark only pending changes as rejected (preserves already-approved entries)
		rejectAllChanges();

		// Refetch file data
		await queryClient.refetchQueries({ queryKey: ['files', projectId] });
		await queryClient.refetchQueries({ queryKey: ['file', projectId] });
	}, [pendingChanges, revertFileAsync, rejectAllChanges, queryClient, projectId]);

	return {
		pendingChanges,
		unresolvedChanges,
		pendingCount,
		canReject,
		isReverting,
		handleApproveChange,
		handleRejectChange,
		handleApproveAll,
		handleRejectAll,
	};
}
