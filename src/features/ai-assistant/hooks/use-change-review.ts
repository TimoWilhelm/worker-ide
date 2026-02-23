/**
 * useChangeReview Hook
 *
 * Manages approval/rejection of AI file changes.
 * Approve = keep the change (file already written by AI).
 * Reject = revert the file using the snapshot API.
 *
 * After each approve/reject action, persists the updated pending changes
 * state to the session on the server so inline diffs survive page refresh.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';

import { computeDiffHunks, groupHunksIntoChanges, reconstructContent } from '@/features/editor/lib/diff-decorations';
import { useSnapshots } from '@/features/snapshots';
import { createApiClient, saveProjectPendingChanges } from '@/lib/api-client';
import { useStore } from '@/lib/store';

import { pendingChangesMapToRecord } from '../lib/session-serializers';

// =============================================================================
// Hook
// =============================================================================

export function useChangeReview({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const { pendingChanges, approveChange, rejectChange, approveHunk, rejectHunk, approveAllChanges, rejectAllChanges } = useStore();
	const { revertFile, revertFileAsync, isReverting } = useSnapshots({ projectId });
	const apiReference = useRef(createApiClient(projectId));

	// Persist the current pending changes state to the project-level file.
	// Reads directly from the store to always get the latest state.
	const persistPendingChanges = useCallback(async () => {
		const { pendingChanges: currentPendingChanges } = useStore.getState();

		try {
			const record = pendingChangesMapToRecord(currentPendingChanges);
			await saveProjectPendingChanges(projectId, record ?? {});
		} catch (error) {
			console.error('Failed to persist pending changes:', error);
		}
	}, [projectId]);

	// Derive list of pending (unresolved) changes
	const unresolvedChanges = useMemo(() => {
		const result: Array<{ path: string; action: 'create' | 'edit' | 'delete' | 'move'; snapshotId: string | undefined }> = [];
		for (const [, change] of pendingChanges) {
			if (change.status === 'pending') {
				result.push({ path: change.path, action: change.action, snapshotId: change.snapshotId });
			}
		}
		return result;
	}, [pendingChanges]);

	const pendingCount = unresolvedChanges.length;

	// Whether any pending change can be rejected (has snapshot, beforeContent, or is a create)
	const canReject = useMemo(() => {
		for (const change of pendingChanges.values()) {
			if (change.status === 'pending' && (change.snapshotId || change.beforeContent !== undefined || change.action === 'create')) {
				return true;
			}
		}
		return false;
	}, [pendingChanges]);

	// Serialized write chain — each reconstructAndWrite call waits for the
	// previous one to complete so rapid hunk decisions don't race.
	const writeChainReference = useRef<Promise<void>>(Promise.resolve());

	// Reconstruct and write the file to disk based on current hunk decisions.
	// Pending hunks keep the AI version; accepted hunks keep the AI version;
	// rejected hunks revert to the original. This is called after each hunk
	// decision so the preview/HMR reflects the user's choices immediately.
	//
	// Writes are serialized via writeChainReference so the latest decision
	// always produces the final on-disk state, even under rapid clicks.
	const reconstructAndWrite = useCallback(
		(path: string): Promise<void> => {
			const writePromise = writeChainReference.current.then(async () => {
				// Read latest state at execution time (after prior writes complete)
				const change = useStore.getState().pendingChanges.get(path);
				if (!change?.beforeContent || !change.afterContent) return;

				const hunks = computeDiffHunks(change.beforeContent, change.afterContent);
				const groups = groupHunksIntoChanges(hunks);

				// pending and approved → true (keep AI version), rejected → false (revert)
				const decisions = groups.map((group) => change.hunkStatuses[group.index] !== 'rejected');
				const reconstructed = reconstructContent(change.beforeContent, change.afterContent, decisions);

				try {
					await apiReference.current.file.$put({ json: { path, content: reconstructed } });
					queryClient.setQueryData(['file', projectId, path], { path, content: reconstructed });
				} catch (error) {
					console.error('Failed to write reconstructed file:', error);
				}
			});
			writeChainReference.current = writePromise;
			return writePromise;
		},
		[queryClient, projectId],
	);

	// Approve a single file change.
	// If per-hunk review is active, approves remaining undecided hunks,
	// reconstructs the file to disk, and finalizes.
	const handleApproveChange = useCallback(
		(path: string) => {
			const change = pendingChanges.get(path);
			if (!change) return;

			approveChange(path);

			// If hunk-level review was active, write the final reconstruction
			if (change.hunkStatuses.length > 0) {
				void reconstructAndWrite(path).then(() => {
					void queryClient.refetchQueries({ queryKey: ['file', projectId] });
				});
			}

			void persistPendingChanges();
		},
		[pendingChanges, approveChange, reconstructAndWrite, queryClient, projectId, persistPendingChanges],
	);

	// Reject a single file change (revert via snapshot API or write back beforeContent).
	// If per-hunk review is active with some accepted hunks, reconstructs to disk
	// (preserving accepted hunks) instead of doing a full revert.
	const handleRejectChange = useCallback(
		(path: string) => {
			const change = pendingChanges.get(path);
			if (!change) return;

			// If some hunks are already accepted, reject remaining and reconstruct
			const hasAcceptedHunks = change.hunkStatuses.includes('approved');
			if (hasAcceptedHunks) {
				rejectChange(path);
				void reconstructAndWrite(path).then(() => {
					void queryClient.refetchQueries({ queryKey: ['file', projectId] });
					void persistPendingChanges();
				});
				return;
			}

			// No accepted hunks — full revert
			if (change.snapshotId) {
				// Preferred: revert through snapshot API
				revertFile(
					{ path, snapshotId: change.snapshotId },
					{
						onSuccess: () => {
							rejectChange(path);
							void persistPendingChanges();
						},
					},
				);
			} else if (change.action === 'edit' && change.beforeContent !== undefined) {
				// Fallback: write back the original content
				void apiReference.current.file.$put({ json: { path, content: change.beforeContent } }).then(
					() => {
						rejectChange(path);
						void queryClient.refetchQueries({ queryKey: ['file', projectId] });
						void persistPendingChanges();
					},
					(error) => {
						console.error('Failed to revert file edit:', error);
						rejectChange(path);
						void persistPendingChanges();
					},
				);
			} else if (change.action === 'create') {
				// Created file with no snapshot — delete it
				void apiReference.current.file.$delete({ query: { path } }).then(
					() => {
						rejectChange(path);
						void queryClient.refetchQueries({ queryKey: ['files', projectId] });
						void persistPendingChanges();
					},
					(error) => {
						console.error('Failed to delete created file:', error);
						rejectChange(path);
						void persistPendingChanges();
					},
				);
			} else {
				// No snapshot and no beforeContent — just mark as rejected
				rejectChange(path);
				void persistPendingChanges();
			}
		},
		[pendingChanges, revertFile, rejectChange, reconstructAndWrite, queryClient, projectId, persistPendingChanges],
	);

	// When all hunks are resolved, mark the file as done and clean up.
	// The file content is already correct on disk from the last reconstructAndWrite call.
	const finalizeReview = useCallback(
		(path: string) => {
			const change = useStore.getState().pendingChanges.get(path);
			if (!change) return;

			const allRejected = change.hunkStatuses.every((status) => status === 'rejected');
			if (allRejected) {
				rejectChange(path);
			} else {
				// All approved, or mixed — file has the user's chosen content
				approveChange(path);
			}

			void queryClient.refetchQueries({ queryKey: ['file', projectId] });
			void persistPendingChanges();
		},
		[approveChange, rejectChange, queryClient, projectId, persistPendingChanges],
	);

	// Approve a single change group (hunk) within a file.
	// Records the decision, writes the reconstructed file to disk, and
	// finalizes the review when all hunks are resolved.
	const handleApproveHunk = useCallback(
		(path: string, groupIndex: number) => {
			const change = pendingChanges.get(path);
			if (!change) return;

			approveHunk(path, groupIndex);
			void reconstructAndWrite(path);

			// Check if all hunks are now resolved
			const updatedChange = useStore.getState().pendingChanges.get(path);
			if (updatedChange && updatedChange.hunkStatuses.every((status) => status !== 'pending')) {
				finalizeReview(path);
			}

			void persistPendingChanges();
		},
		[pendingChanges, approveHunk, reconstructAndWrite, finalizeReview, persistPendingChanges],
	);

	// Reject a single change group (hunk) within a file.
	// Records the decision, writes the reconstructed file to disk, and
	// finalizes the review when all hunks are resolved.
	const handleRejectHunk = useCallback(
		(path: string, groupIndex: number) => {
			const change = pendingChanges.get(path);
			if (!change) return;

			rejectHunk(path, groupIndex);
			void reconstructAndWrite(path);

			// Check if all hunks are now resolved
			const updatedChange = useStore.getState().pendingChanges.get(path);
			if (updatedChange && updatedChange.hunkStatuses.every((status) => status !== 'pending')) {
				finalizeReview(path);
			}

			void persistPendingChanges();
		},
		[pendingChanges, rejectHunk, reconstructAndWrite, finalizeReview, persistPendingChanges],
	);

	// Approve all pending changes.
	// When called from the AI panel (with sessionId), only affects that session's changes.
	const handleApproveAll = useCallback(
		(sessionId?: string) => {
			approveAllChanges(sessionId);
			void persistPendingChanges();
		},
		[approveAllChanges, persistPendingChanges],
	);

	// Reject all pending changes (revert each file individually).
	// When called from the AI panel (with sessionId), only affects that session's changes.
	// Files with some accepted hunks get a partial reconstruction instead of full revert.
	const handleRejectAll = useCallback(
		async (sessionId?: string) => {
			const revertPromises: Promise<unknown>[] = [];

			// First pass: mark all pending hunkStatuses as rejected (session-scoped if provided)
			rejectAllChanges(sessionId);

			for (const change of pendingChanges.values()) {
				if (change.status !== 'pending') continue;
				if (sessionId && change.sessionId !== sessionId) continue;

				const hasAcceptedHunks = change.hunkStatuses.includes('approved');

				if (hasAcceptedHunks) {
					// Partial review with some accepted hunks — reconstruct
					revertPromises.push(reconstructAndWrite(change.path));
				} else if (change.snapshotId) {
					// Preferred: revert through snapshot API
					revertPromises.push(revertFileAsync({ path: change.path, snapshotId: change.snapshotId }));
				} else if (change.action === 'edit' && change.beforeContent !== undefined) {
					// Fallback: write back the original content
					revertPromises.push(apiReference.current.file.$put({ json: { path: change.path, content: change.beforeContent } }));
				} else if (change.action === 'create') {
					// Created file with no snapshot — delete it
					revertPromises.push(apiReference.current.file.$delete({ query: { path: change.path } }));
				}
			}

			// Await all reverts/reconstructs before persisting
			await Promise.allSettled(revertPromises);

			// Persist the updated pending changes state
			await persistPendingChanges();

			// Refetch file data
			await queryClient.refetchQueries({ queryKey: ['files', projectId] });
			await queryClient.refetchQueries({ queryKey: ['file', projectId] });
		},
		[pendingChanges, revertFileAsync, rejectAllChanges, reconstructAndWrite, queryClient, projectId, persistPendingChanges],
	);

	// Session-scoped pending count for the AI panel display
	const sessionPendingCount = useCallback(
		(sessionId?: string) => {
			if (!sessionId) return pendingCount;
			let count = 0;
			for (const change of pendingChanges.values()) {
				if (change.status === 'pending' && change.sessionId === sessionId) {
					count++;
				}
			}
			return count;
		},
		[pendingChanges, pendingCount],
	);

	return {
		pendingChanges,
		unresolvedChanges,
		pendingCount,
		sessionPendingCount,
		canReject,
		isReverting,
		handleApproveChange,
		handleRejectChange,
		handleApproveHunk,
		handleRejectHunk,
		handleApproveAll,
		handleRejectAll,
	};
}
