import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { toast } from '@/components/ui/toast-store';
import { resolveReviewContent } from '@/features/editor/lib/diff-decorations';
import { createApiClient } from '@/lib/api-client';
import { useStore } from '@/lib/store';

import type { PendingFileChange } from '@shared/types';

function matchesSession(change: PendingFileChange, sessionId?: string): boolean {
	if (!sessionId) {
		return true;
	}
	return change.sessionId === sessionId || change.sessionIds?.includes(sessionId) === true;
}

function isReviewActionable(change: PendingFileChange): boolean {
	return typeof change.reviewId === 'string' && change.reviewId.length > 0;
}

function buildLiveContentRecord(changes: PendingFileChange[], getContent: (path: string) => string | undefined): Record<string, string> {
	const record: Record<string, string> = {};
	for (const change of changes) {
		const content = getContent(change.path);
		if (content !== undefined) {
			record[change.path] = content;
		}
	}
	return record;
}

interface UseChangeReviewOptions {
	projectId: string;
	getLiveContent?: (path: string) => string | undefined;
}

export function useChangeReview({ projectId, getLiveContent }: UseChangeReviewOptions) {
	const queryClient = useQueryClient();
	const apiReference = useRef(createApiClient(projectId));
	const [pendingMutationCount, setPendingMutationCount] = useState(0);
	const { pendingChanges, approveChange, rejectChange, approveHunk, rejectHunk, approveAllChanges, rejectAllChanges, loadPendingChanges } =
		useStore(
			useShallow((state) => ({
				pendingChanges: state.pendingChanges,
				approveChange: state.approveChange,
				rejectChange: state.rejectChange,
				approveHunk: state.approveHunk,
				rejectHunk: state.rejectHunk,
				approveAllChanges: state.approveAllChanges,
				rejectAllChanges: state.rejectAllChanges,
				loadPendingChanges: state.loadPendingChanges,
			})),
		);

	const persistPendingChanges = useCallback(async () => {
		// Review state is server-authoritative and syncs back through agent state.
	}, []);

	const unresolvedChanges = useMemo(() => {
		const result: Array<{ path: string; action: PendingFileChange['action']; snapshotId: string | undefined }> = [];
		for (const [, change] of pendingChanges) {
			if (change.status === 'pending') {
				result.push({ path: change.path, action: change.action, snapshotId: change.snapshotId });
			}
		}
		return result;
	}, [pendingChanges]);

	const pendingCount = unresolvedChanges.length;

	const canReject = useMemo(() => {
		for (const change of pendingChanges.values()) {
			if (change.status !== 'pending' || !isReviewActionable(change)) {
				continue;
			}
			if (change.snapshotId || change.beforeContent !== undefined || change.action === 'create') {
				return true;
			}
		}
		return false;
	}, [pendingChanges]);

	const refetchProjectFiles = useCallback(async () => {
		await queryClient.refetchQueries({ queryKey: ['files', projectId] });
		await queryClient.refetchQueries({ queryKey: ['file', projectId] });
	}, [projectId, queryClient]);

	const runMutation = useCallback(async <T>(mutation: () => Promise<T>): Promise<T> => {
		setPendingMutationCount((count) => count + 1);
		try {
			return await mutation();
		} finally {
			setPendingMutationCount((count) => Math.max(0, count - 1));
		}
	}, []);

	const setOptimisticFileContent = useCallback(
		(change: PendingFileChange) => {
			const cachedContent = queryClient.getQueryData<{ content: string }>(['file', projectId, change.path])?.content;
			const liveContent = getLiveContent?.(change.path) ?? cachedContent ?? change.afterContent ?? change.beforeContent ?? '';
			const resolution = resolveReviewContent({
				action: change.action,
				beforeContent: change.beforeContent,
				agentAfterContent: change.afterContent,
				liveContent,
				hunkStatuses: change.hunkStatuses,
				finalizing: true,
			});

			if (resolution.action === 'delete') {
				queryClient.removeQueries({ queryKey: ['file', projectId, change.path], exact: true });
				return;
			}

			queryClient.setQueryData(['file', projectId, change.path], { path: change.path, content: resolution.content });
		},
		[getLiveContent, projectId, queryClient],
	);

	const getReviewLiveContent = useCallback(
		(path: string) => getLiveContent?.(path) ?? queryClient.getQueryData<{ content: string }>(['file', projectId, path])?.content,
		[getLiveContent, projectId, queryClient],
	);

	const handleApproveChange = useCallback(
		(path: string) => {
			const change = pendingChanges.get(path);
			if (!change || !isReviewActionable(change) || !change.reviewId) {
				return;
			}
			const reviewId = change.reviewId;

			const previousChanges = new Map(useStore.getState().pendingChanges);
			approveChange(path);
			const updatedChange = useStore.getState().pendingChanges.get(path) ?? change;
			setOptimisticFileContent(updatedChange);

			void runMutation(async () => {
				const response = await apiReference.current.review[':id'].resolve.$post({
					param: { id: reviewId },
					json: { decision: 'accept', liveContent: getReviewLiveContent(path) },
				});
				if (!response.ok) {
					throw new Error('Failed to accept change');
				}
				await refetchProjectFiles();
				await persistPendingChanges();
			}).catch(() => {
				loadPendingChanges(previousChanges);
				toast.error('Could not accept this change. Please try again.');
				void refetchProjectFiles();
			});
		},
		[
			pendingChanges,
			approveChange,
			loadPendingChanges,
			setOptimisticFileContent,
			runMutation,
			refetchProjectFiles,
			persistPendingChanges,
			getReviewLiveContent,
		],
	);

	const handleRejectChange = useCallback(
		(path: string) => {
			const change = pendingChanges.get(path);
			if (!change || !isReviewActionable(change) || !change.reviewId) {
				return;
			}
			const reviewId = change.reviewId;

			const previousChanges = new Map(useStore.getState().pendingChanges);
			rejectChange(path);
			const updatedChange = useStore.getState().pendingChanges.get(path) ?? change;
			setOptimisticFileContent(updatedChange);

			void runMutation(async () => {
				const response = await apiReference.current.review[':id'].resolve.$post({
					param: { id: reviewId },
					json: { decision: 'reject', liveContent: getReviewLiveContent(path) },
				});
				if (!response.ok) {
					throw new Error('Failed to reject change');
				}
				await refetchProjectFiles();
				await persistPendingChanges();
			}).catch(() => {
				loadPendingChanges(previousChanges);
				toast.error('Could not reject this change. Please try again.');
				void refetchProjectFiles();
			});
		},
		[
			pendingChanges,
			rejectChange,
			loadPendingChanges,
			setOptimisticFileContent,
			runMutation,
			refetchProjectFiles,
			persistPendingChanges,
			getReviewLiveContent,
		],
	);

	const handleApproveHunk = useCallback(
		(path: string, groupIndex: number) => {
			const change = pendingChanges.get(path);
			if (!change || !isReviewActionable(change) || !change.reviewId) {
				return;
			}
			const reviewId = change.reviewId;

			const previousChanges = new Map(useStore.getState().pendingChanges);
			approveHunk(path, groupIndex);
			const updatedChange = useStore.getState().pendingChanges.get(path);
			if (!updatedChange) {
				return;
			}
			setOptimisticFileContent(updatedChange);

			void runMutation(async () => {
				const response = await apiReference.current.review[':id'].hunks.$put({
					param: { id: reviewId },
					json: { hunkStatuses: updatedChange.hunkStatuses, liveContent: getReviewLiveContent(path) },
				});
				if (!response.ok) {
					throw new Error('Failed to update hunk review');
				}
				await refetchProjectFiles();
				await persistPendingChanges();
			}).catch(() => {
				loadPendingChanges(previousChanges);
				toast.error('Could not accept this hunk. Please try again.');
				void refetchProjectFiles();
			});
		},
		[
			pendingChanges,
			approveHunk,
			loadPendingChanges,
			setOptimisticFileContent,
			runMutation,
			refetchProjectFiles,
			persistPendingChanges,
			getReviewLiveContent,
		],
	);

	const handleRejectHunk = useCallback(
		(path: string, groupIndex: number) => {
			const change = pendingChanges.get(path);
			if (!change || !isReviewActionable(change) || !change.reviewId) {
				return;
			}
			const reviewId = change.reviewId;

			const previousChanges = new Map(useStore.getState().pendingChanges);
			rejectHunk(path, groupIndex);
			const updatedChange = useStore.getState().pendingChanges.get(path);
			if (!updatedChange) {
				return;
			}
			setOptimisticFileContent(updatedChange);

			void runMutation(async () => {
				const response = await apiReference.current.review[':id'].hunks.$put({
					param: { id: reviewId },
					json: { hunkStatuses: updatedChange.hunkStatuses, liveContent: getReviewLiveContent(path) },
				});
				if (!response.ok) {
					throw new Error('Failed to update hunk review');
				}
				await refetchProjectFiles();
				await persistPendingChanges();
			}).catch(() => {
				loadPendingChanges(previousChanges);
				toast.error('Could not reject this hunk. Please try again.');
				void refetchProjectFiles();
			});
		},
		[
			pendingChanges,
			rejectHunk,
			loadPendingChanges,
			setOptimisticFileContent,
			runMutation,
			refetchProjectFiles,
			persistPendingChanges,
			getReviewLiveContent,
		],
	);

	const handleApproveAll = useCallback(
		(sessionId?: string) => {
			const actionableChanges = [...pendingChanges.values()].filter(
				(change) => change.status === 'pending' && matchesSession(change, sessionId) && isReviewActionable(change),
			);
			if (actionableChanges.length === 0) {
				return;
			}

			const previousChanges = new Map(useStore.getState().pendingChanges);
			for (const change of actionableChanges) {
				setOptimisticFileContent({
					...change,
					hunkStatuses: change.hunkStatuses.map((status) => (status === 'pending' ? 'approved' : status)),
				});
			}
			approveAllChanges(sessionId);

			void runMutation(async () => {
				const liveContents = buildLiveContentRecord(actionableChanges, getReviewLiveContent);
				const response = await apiReference.current.review['resolve-many'].$post({
					json: {
						decision: 'accept',
						reviewIds: actionableChanges.map((change) => change.reviewId!).filter(Boolean),
						liveContents,
					},
				});
				if (!response.ok) {
					throw new Error('Failed to accept changes');
				}
				await refetchProjectFiles();
				await persistPendingChanges();
			}).catch(() => {
				loadPendingChanges(previousChanges);
				toast.error('Could not accept all changes. Please try again.');
				void refetchProjectFiles();
			});
		},
		[
			pendingChanges,
			loadPendingChanges,
			setOptimisticFileContent,
			approveAllChanges,
			runMutation,
			refetchProjectFiles,
			persistPendingChanges,
			getReviewLiveContent,
		],
	);

	const handleRejectAll = useCallback(
		async (sessionId?: string) => {
			const actionableChanges = [...pendingChanges.values()].filter(
				(change) => change.status === 'pending' && matchesSession(change, sessionId) && isReviewActionable(change),
			);
			if (actionableChanges.length === 0) {
				return;
			}

			const previousChanges = new Map(useStore.getState().pendingChanges);
			for (const change of actionableChanges) {
				setOptimisticFileContent({
					...change,
					hunkStatuses: change.hunkStatuses.map((status) => (status === 'pending' ? 'rejected' : status)),
				});
			}
			rejectAllChanges(sessionId);

			try {
				await runMutation(async () => {
					const liveContents = buildLiveContentRecord(actionableChanges, getReviewLiveContent);
					const response = await apiReference.current.review['resolve-many'].$post({
						json: {
							decision: 'reject',
							reviewIds: actionableChanges.map((change) => change.reviewId!).filter(Boolean),
							liveContents,
						},
					});
					if (!response.ok) {
						throw new Error('Failed to reject changes');
					}
					await refetchProjectFiles();
					await persistPendingChanges();
				});
			} catch {
				loadPendingChanges(previousChanges);
				toast.error('Could not reject all changes. Please try again.');
				await refetchProjectFiles();
			}
		},
		[
			pendingChanges,
			loadPendingChanges,
			setOptimisticFileContent,
			rejectAllChanges,
			runMutation,
			refetchProjectFiles,
			persistPendingChanges,
			getReviewLiveContent,
		],
	);

	const sessionPendingCount = useCallback(
		(sessionId?: string) => {
			if (!sessionId) return 0;
			let count = 0;
			for (const change of pendingChanges.values()) {
				if (change.status === 'pending' && matchesSession(change, sessionId)) {
					count++;
				}
			}
			return count;
		},
		[pendingChanges],
	);

	return {
		pendingChanges,
		unresolvedChanges,
		pendingCount,
		sessionPendingCount,
		canReject,
		isReverting: pendingMutationCount > 0,
		persistPendingChanges,
		handleApproveChange,
		handleRejectChange,
		handleApproveHunk,
		handleRejectHunk,
		handleApproveAll,
		handleRejectAll,
	};
}
