/**
 * useGitMutations Hook
 *
 * Provides mutation functions for all git write operations:
 * stage, unstage, commit, branch, checkout, merge, tag, stash, discard.
 *
 * Staging and discard mutations use optimistic updates: the query cache is
 * updated immediately to predict the result, then corrected by the server
 * response (inline git status). On error, the previous state is restored
 * and an error toast is shown.
 *
 * Other mutations (commit, branch, checkout, merge, tag, stash) are NOT
 * optimistically updated because their effects are less predictable. They
 * still apply inline status on success and show toasts on error.
 *
 * Mutation responses include inline git status, which is applied directly
 * to the query cache. This avoids a separate status refetch that would
 * race with isomorphic-git's internal AsyncLock on Cloudflare Workers
 * (the lock holds closures from the mutation request's I/O context, and
 * a new request's statusMatrix call would use stale references).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { toast } from '@/components/ui/toast-store';
import { createApiClient } from '@/lib/api-client';

import type { GitMergeResult, GitFileStatus, GitStatusEntry } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface UseGitMutationsOptions {
	projectId: string;
}

interface GitStatusResponse {
	entries: GitStatusEntry[];
	initialized: boolean;
}

interface MutationContext {
	previous: GitStatusResponse | undefined;
}

// =============================================================================
// Optimistic status transforms
// =============================================================================

/** Map of status → what it becomes when staged. */
const STAGE_STATUS_MAP: Partial<Record<GitFileStatus, GitFileStatus>> = {
	untracked: 'untracked-staged',
	modified: 'modified-staged',
	deleted: 'deleted-staged',
};

/** Map of status → what it becomes when unstaged. */
const UNSTAGE_STATUS_MAP: Partial<Record<GitFileStatus, GitFileStatus>> = {
	'untracked-staged': 'untracked',
	'untracked-partially-staged': 'untracked',
	'modified-staged': 'modified',
	'modified-partially-staged': 'modified',
	'deleted-staged': 'deleted',
};

/**
 * Optimistically stage files: transform matching entries so they appear staged.
 */
function optimisticStage(entries: GitStatusEntry[], paths: string[]): GitStatusEntry[] {
	const pathSet = new Set(paths);
	return entries.map((entry) => {
		if (!pathSet.has(entry.path)) return entry;
		const newStatus = STAGE_STATUS_MAP[entry.status];
		if (!newStatus) return entry; // Already staged or unmodified
		return { ...entry, status: newStatus, staged: true };
	});
}

/**
 * Optimistically unstage files: transform matching entries so they appear unstaged.
 */
function optimisticUnstage(entries: GitStatusEntry[], paths: string[]): GitStatusEntry[] {
	const pathSet = new Set(paths);
	return entries.map((entry) => {
		if (!pathSet.has(entry.path)) return entry;
		const newStatus = UNSTAGE_STATUS_MAP[entry.status];
		if (!newStatus) return entry; // Already unstaged
		return { ...entry, status: newStatus, staged: false };
	});
}

/**
 * Optimistically stage all files.
 */
function optimisticStageAll(entries: GitStatusEntry[]): GitStatusEntry[] {
	return entries.map((entry) => {
		const newStatus = STAGE_STATUS_MAP[entry.status];
		if (!newStatus) return entry;
		return { ...entry, status: newStatus, staged: true };
	});
}

/**
 * Optimistically unstage all files.
 */
function optimisticUnstageAll(entries: GitStatusEntry[]): GitStatusEntry[] {
	return entries.map((entry) => {
		const newStatus = UNSTAGE_STATUS_MAP[entry.status];
		if (!newStatus) return entry;
		return { ...entry, status: newStatus, staged: false };
	});
}

/**
 * Optimistically discard a single file: remove it from the entries list.
 * (Discarded files revert to HEAD state = unmodified, so they disappear from status.)
 */
function optimisticDiscard(entries: GitStatusEntry[], path: string): GitStatusEntry[] {
	return entries.filter((entry) => entry.path !== path);
}

/**
 * Optimistically discard all changes: remove all unstaged and untracked entries.
 * Staged entries remain untouched.
 */
function optimisticDiscardAll(entries: GitStatusEntry[]): GitStatusEntry[] {
	return entries.filter((entry) => entry.staged);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse an error message from a failed response.
 * Uses response.text() + JSON.parse to escape Hono RPC's typed json() union.
 */
async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
	try {
		const text = await response.text();
		const data: unknown = JSON.parse(text);
		if (data && typeof data === 'object' && 'error' in data) {
			const { error } = data;
			return String(error);
		}
	} catch {
		// Ignore parse errors
	}
	return fallback;
}

/**
 * Parse the mutation response body. We use response.text() + JSON.parse
 * instead of response.json() to avoid Hono RPC's typed union inference
 * which merges success and error response types.
 */
async function parseMutationResponse<T>(response: Response): Promise<T> {
	const text = await response.text();
	const data: T = JSON.parse(text);
	return data;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook providing all git mutation operations.
 */
export function useGitMutations({ projectId }: UseGitMutationsOptions) {
	const queryClient = useQueryClient();
	const api = createApiClient(projectId);

	const statusQueryKey = ['git-status', projectId];

	// =========================================================================
	// Cache helpers
	// =========================================================================

	/**
	 * Apply inline git status from a mutation response directly to the
	 * query cache. This updates the UI immediately without a network
	 * round-trip, and avoids the cross-request AsyncLock race.
	 */
	const applyInlineGitStatus = (gitStatus: GitStatusResponse | undefined) => {
		if (gitStatus) {
			queryClient.setQueryData(statusQueryKey, gitStatus);
		}
	};

	/** Invalidate git queries that are NOT status (branches, log). */
	const invalidateNonStatusGitQueries = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ['git-branches', projectId] }),
			queryClient.invalidateQueries({ queryKey: ['git-log', projectId] }),
		]);
	};

	/**
	 * Snapshot the current git status for optimistic rollback.
	 * Cancels in-flight queries to prevent them overwriting the optimistic update.
	 */
	const snapshotStatus = async (): Promise<MutationContext> => {
		await queryClient.cancelQueries({ queryKey: statusQueryKey });
		const previous = queryClient.getQueryData<GitStatusResponse>(statusQueryKey);
		return { previous };
	};

	/**
	 * Rollback the optimistic update by restoring the previous snapshot.
	 */
	const rollbackStatus = (context: MutationContext | undefined) => {
		if (context?.previous) {
			queryClient.setQueryData(statusQueryKey, context.previous);
		}
	};

	// =========================================================================
	// Staging
	// =========================================================================

	const stageFiles = useMutation({
		mutationFn: async (paths: string[]) => {
			const response = await api.git.stage.$post({ json: { paths } });
			if (!response.ok) {
				throw new Error('Failed to stage files');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onMutate: async (paths) => {
			const context = await snapshotStatus();
			queryClient.setQueryData<GitStatusResponse>(statusQueryKey, (old) => {
				if (!old) return old;
				return { ...old, entries: optimisticStage(old.entries, paths) };
			});
			return context;
		},
		onSuccess: (data) => {
			applyInlineGitStatus(data.gitStatus);
		},
		onError: (_error, _paths, context) => {
			rollbackStatus(context);
			toast.error('Failed to stage files');
		},
	});

	const unstageFiles = useMutation({
		mutationFn: async (paths: string[]) => {
			const response = await api.git.unstage.$post({ json: { paths } });
			if (!response.ok) {
				throw new Error('Failed to unstage files');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onMutate: async (paths) => {
			const context = await snapshotStatus();
			queryClient.setQueryData<GitStatusResponse>(statusQueryKey, (old) => {
				if (!old) return old;
				return { ...old, entries: optimisticUnstage(old.entries, paths) };
			});
			return context;
		},
		onSuccess: (data) => {
			applyInlineGitStatus(data.gitStatus);
		},
		onError: (_error, _paths, context) => {
			rollbackStatus(context);
			toast.error('Failed to unstage files');
		},
	});

	const stageAll = useMutation({
		mutationFn: async () => {
			const response = await api.git['stage-all'].$post({});
			if (!response.ok) {
				throw new Error('Failed to stage all files');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onMutate: async () => {
			const context = await snapshotStatus();
			queryClient.setQueryData<GitStatusResponse>(statusQueryKey, (old) => {
				if (!old) return old;
				return { ...old, entries: optimisticStageAll(old.entries) };
			});
			return context;
		},
		onSuccess: (data) => {
			applyInlineGitStatus(data.gitStatus);
		},
		onError: (_error, _variables, context) => {
			rollbackStatus(context);
			toast.error('Failed to stage all files');
		},
	});

	const unstageAll = useMutation({
		mutationFn: async () => {
			const response = await api.git['unstage-all'].$post({});
			if (!response.ok) {
				throw new Error('Failed to unstage all files');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onMutate: async () => {
			const context = await snapshotStatus();
			queryClient.setQueryData<GitStatusResponse>(statusQueryKey, (old) => {
				if (!old) return old;
				return { ...old, entries: optimisticUnstageAll(old.entries) };
			});
			return context;
		},
		onSuccess: (data) => {
			applyInlineGitStatus(data.gitStatus);
		},
		onError: (_error, _variables, context) => {
			rollbackStatus(context);
			toast.error('Failed to unstage all files');
		},
	});

	// =========================================================================
	// Discard
	// =========================================================================

	const discardChanges = useMutation({
		mutationFn: async (path: string) => {
			const response = await api.git.discard.$post({ json: { path } });
			if (!response.ok) {
				throw new Error('Failed to discard changes');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onMutate: async (path) => {
			const context = await snapshotStatus();
			queryClient.setQueryData<GitStatusResponse>(statusQueryKey, (old) => {
				if (!old) return old;
				return { ...old, entries: optimisticDiscard(old.entries, path) };
			});
			return context;
		},
		onSuccess: async (data) => {
			applyInlineGitStatus(data.gitStatus);
			await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
			await queryClient.invalidateQueries({ queryKey: ['file', projectId] });
		},
		onError: (_error, _path, context) => {
			rollbackStatus(context);
			toast.error('Failed to discard changes');
		},
	});

	const discardAll = useMutation({
		mutationFn: async () => {
			const response = await api.git['discard-all'].$post({});
			if (!response.ok) {
				throw new Error('Failed to discard all changes');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onMutate: async () => {
			const context = await snapshotStatus();
			queryClient.setQueryData<GitStatusResponse>(statusQueryKey, (old) => {
				if (!old) return old;
				return { ...old, entries: optimisticDiscardAll(old.entries) };
			});
			return context;
		},
		onSuccess: async (data) => {
			applyInlineGitStatus(data.gitStatus);
			await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
			await queryClient.invalidateQueries({ queryKey: ['file', projectId] });
		},
		onError: (_error, _variables, context) => {
			rollbackStatus(context);
			toast.error('Failed to discard all changes');
		},
	});

	// =========================================================================
	// Commits
	// =========================================================================

	const commit = useMutation({
		mutationFn: async (parameters: { message: string; amend?: boolean }) => {
			const response = await api.git.commit.$post({ json: parameters });
			if (!response.ok) {
				throw new Error(await parseErrorMessage(response, 'Failed to create commit'));
			}
			return parseMutationResponse<{ objectId: string; gitStatus?: GitStatusResponse }>(response);
		},
		onSuccess: async (data) => {
			applyInlineGitStatus(data.gitStatus);
			await invalidateNonStatusGitQueries();
		},
		// No toast — commit errors are shown inline in the commit form,
		// which provides better context than a floating notification.
	});

	// =========================================================================
	// Branches
	// =========================================================================

	const createBranch = useMutation({
		mutationFn: async (parameters: { name: string; checkout?: boolean }) => {
			const response = await api.git.branch.$post({ json: parameters });
			if (!response.ok) {
				throw new Error(await parseErrorMessage(response, 'Failed to create branch'));
			}
		},
		onSuccess: invalidateNonStatusGitQueries,
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const deleteBranch = useMutation({
		mutationFn: async (name: string) => {
			const response = await api.git.branch.$delete({ query: { name } });
			if (!response.ok) {
				throw new Error(await parseErrorMessage(response, 'Failed to delete branch'));
			}
		},
		onSuccess: invalidateNonStatusGitQueries,
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const renameBranch = useMutation({
		mutationFn: async (parameters: { oldName: string; newName: string }) => {
			const response = await api.git.branch.rename.$post({ json: parameters });
			if (!response.ok) {
				throw new Error(await parseErrorMessage(response, 'Failed to rename branch'));
			}
		},
		onSuccess: invalidateNonStatusGitQueries,
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const checkout = useMutation({
		mutationFn: async (reference: string) => {
			const response = await api.git.checkout.$post({ json: { reference } });
			if (!response.ok) {
				throw new Error(await parseErrorMessage(response, 'Failed to checkout'));
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onSuccess: async (data) => {
			applyInlineGitStatus(data.gitStatus);
			await invalidateNonStatusGitQueries();
			await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
			await queryClient.refetchQueries({ queryKey: ['file', projectId] });
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	// =========================================================================
	// Merge
	// =========================================================================

	const merge = useMutation({
		mutationFn: async (branch: string) => {
			const response = await api.git.merge.$post({ json: { branch } });
			if (!response.ok) {
				throw new Error(await parseErrorMessage(response, 'Failed to merge'));
			}
			return parseMutationResponse<GitMergeResult & { gitStatus?: GitStatusResponse }>(response);
		},
		onSuccess: async (data) => {
			applyInlineGitStatus(data.gitStatus);
			await invalidateNonStatusGitQueries();
			await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
			await queryClient.refetchQueries({ queryKey: ['file', projectId] });
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	// =========================================================================
	// Tags
	// =========================================================================

	const createTag = useMutation({
		mutationFn: async (parameters: { name: string; reference?: string }) => {
			const response = await api.git.tag.$post({ json: parameters });
			if (!response.ok) {
				throw new Error(await parseErrorMessage(response, 'Failed to create tag'));
			}
		},
		onSuccess: invalidateNonStatusGitQueries,
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const deleteTag = useMutation({
		mutationFn: async (name: string) => {
			const response = await api.git.tag.$delete({ query: { name } });
			if (!response.ok) {
				throw new Error(await parseErrorMessage(response, 'Failed to delete tag'));
			}
		},
		onSuccess: invalidateNonStatusGitQueries,
		onError: (error) => {
			toast.error(error.message);
		},
	});

	// =========================================================================
	// Stash
	// =========================================================================

	const stashPush = useMutation({
		mutationFn: async (message?: string) => {
			const response = await api.git.stash.$post({ json: { action: 'push', message } });
			if (!response.ok) {
				throw new Error('Failed to push stash');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onSuccess: (data) => {
			applyInlineGitStatus(data.gitStatus);
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const stashPop = useMutation({
		mutationFn: async (index?: number) => {
			const response = await api.git.stash.$post({ json: { action: 'pop', index } });
			if (!response.ok) {
				throw new Error('Failed to pop stash');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onSuccess: async (data) => {
			applyInlineGitStatus(data.gitStatus);
			await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
			await queryClient.refetchQueries({ queryKey: ['file', projectId] });
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const stashApply = useMutation({
		mutationFn: async (index?: number) => {
			const response = await api.git.stash.$post({ json: { action: 'apply', index } });
			if (!response.ok) {
				throw new Error('Failed to apply stash');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onSuccess: async (data) => {
			applyInlineGitStatus(data.gitStatus);
			await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
			await queryClient.refetchQueries({ queryKey: ['file', projectId] });
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const stashDrop = useMutation({
		mutationFn: async (index?: number) => {
			const response = await api.git.stash.$post({ json: { action: 'drop', index } });
			if (!response.ok) {
				throw new Error('Failed to drop stash');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onSuccess: (data) => {
			applyInlineGitStatus(data.gitStatus);
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const stashClear = useMutation({
		mutationFn: async () => {
			const response = await api.git.stash.$post({ json: { action: 'clear' } });
			if (!response.ok) {
				throw new Error('Failed to clear stash');
			}
			return parseMutationResponse<{ success: boolean; gitStatus?: GitStatusResponse }>(response);
		},
		onSuccess: (data) => {
			applyInlineGitStatus(data.gitStatus);
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	return {
		// Staging
		stageFiles: stageFiles.mutate,
		stageFilesAsync: stageFiles.mutateAsync,
		unstageFiles: unstageFiles.mutate,
		unstageFilesAsync: unstageFiles.mutateAsync,
		stageAll: stageAll.mutate,
		unstageAll: unstageAll.mutate,

		// Discard
		discardChanges: discardChanges.mutate,
		discardChangesAsync: discardChanges.mutateAsync,
		discardAll: discardAll.mutate,

		// Commits
		commit: commit.mutate,
		commitAsync: commit.mutateAsync,
		isCommitSuccess: commit.isSuccess,

		// Branches
		createBranch: createBranch.mutate,
		createBranchAsync: createBranch.mutateAsync,
		deleteBranch: deleteBranch.mutate,
		renameBranch: renameBranch.mutate,
		checkout: checkout.mutate,
		checkoutAsync: checkout.mutateAsync,

		// Merge
		merge: merge.mutate,
		mergeAsync: merge.mutateAsync,

		// Tags
		createTag: createTag.mutate,
		deleteTag: deleteTag.mutate,

		// Stash
		stashPush: stashPush.mutate,
		stashPop: stashPop.mutate,
		stashApply: stashApply.mutate,
		stashDrop: stashDrop.mutate,
		stashClear: stashClear.mutate,

		// Loading states
		isStagePending: stageFiles.isPending || unstageFiles.isPending || stageAll.isPending || unstageAll.isPending,
		isCommitPending: commit.isPending,
		isBranchPending: createBranch.isPending || deleteBranch.isPending || renameBranch.isPending || checkout.isPending,
		isMergePending: merge.isPending,
		isStashPending: stashPush.isPending || stashPop.isPending || stashApply.isPending || stashDrop.isPending || stashClear.isPending,
		isDiscardPending: discardChanges.isPending || discardAll.isPending,

		// Error states
		commitError: commit.error,
		mergeError: merge.error,
	};
}
