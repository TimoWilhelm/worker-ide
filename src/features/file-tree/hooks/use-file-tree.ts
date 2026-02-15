/**
 * useFileTree Hook
 *
 * Hook for loading and managing file tree state.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { toast } from '@/components/ui/toast-store';
import { createApiClient } from '@/lib/api-client';
import { useStore } from '@/lib/store';

import type { FileInfo } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface UseFileTreeOptions {
	projectId: string;
	enabled?: boolean;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for loading and managing the file tree.
 * Syncs with global store for UI state (selection, expansion).
 */
export function useFileTree({ projectId, enabled = true }: UseFileTreeOptions) {
	const queryClient = useQueryClient();
	const api = createApiClient(projectId);

	// Store state
	const {
		setFiles,
		setSelectedFile,
		toggleDirectory,
		openFile,
		setLoading,
		files,
		selectedFile,
		expandedDirs: expandedDirectories,
	} = useStore();

	// Query for fetching files
	const query = useQuery({
		queryKey: ['files', projectId],
		queryFn: async () => {
			const response = await api.files.$get({});

			if (!response.ok) {
				throw new Error('Failed to load files');
			}

			const data: { files: FileInfo[] } = await response.json();
			return data.files;
		},
		enabled,
		staleTime: 1000 * 30, // 30 seconds
	});

	// Sync query data with store
	useEffect(() => {
		if (query.data) {
			setFiles(query.data);
		}
		setLoading(query.isLoading);
	}, [query.data, query.isLoading, setFiles, setLoading]);

	// Mutation for creating files
	const createFileMutation = useMutation({
		mutationFn: async ({ path, content = '' }: { path: string; content?: string }) => {
			const response = await api.file.$put({
				json: { path, content },
			});

			if (!response.ok) {
				throw new Error('Failed to create file');
			}

			return response.json();
		},
		onMutate: async (variables) => {
			await queryClient.cancelQueries({ queryKey: ['files', projectId] });
			const previous = queryClient.getQueryData<FileInfo[]>(['files', projectId]);
			if (previous) {
				queryClient.setQueryData<FileInfo[]>(
					['files', projectId],
					[...previous, { path: variables.path, name: variables.path.split('/').pop() ?? '', isDirectory: false }],
				);
			}
			setSelectedFile(variables.path);
			openFile(variables.path);
			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) {
				queryClient.setQueryData(['files', projectId], context.previous);
			}
			toast.error('Failed to create file');
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
		},
	});

	// Mutation for deleting files (uses query parameter, not JSON body)
	const deleteFileMutation = useMutation({
		mutationFn: async (path: string) => {
			const response = await api.file.$delete({
				query: { path },
			});

			if (!response.ok) {
				throw new Error('Failed to delete file');
			}

			return response.json();
		},
		onMutate: async (path) => {
			await queryClient.cancelQueries({ queryKey: ['files', projectId] });
			const previous = queryClient.getQueryData<FileInfo[]>(['files', projectId]);
			if (previous) {
				queryClient.setQueryData<FileInfo[]>(
					['files', projectId],
					previous.filter((f) => f.path !== path && !f.path.startsWith(path + '/')),
				);
			}
			return { previous };
		},
		onError: (_error, _path, context) => {
			if (context?.previous) {
				queryClient.setQueryData(['files', projectId], context.previous);
			}
			toast.error('Failed to delete file');
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
		},
	});

	// Mutation for renaming/moving files
	const renameFileMutation = useMutation({
		mutationFn: async ({ fromPath, toPath }: { fromPath: string; toPath: string }) => {
			const response = await api.file.$patch({
				json: { from_path: fromPath, to_path: toPath },
			});

			if (!response.ok) {
				throw new Error('Failed to rename file');
			}

			return response.json();
		},
		onMutate: async (variables) => {
			await queryClient.cancelQueries({ queryKey: ['files', projectId] });
			const previous = queryClient.getQueryData<FileInfo[]>(['files', projectId]);
			if (previous) {
				queryClient.setQueryData<FileInfo[]>(
					['files', projectId],
					previous.map((f) => {
						if (f.path === variables.fromPath) {
							return { ...f, path: variables.toPath, name: variables.toPath.split('/').pop() ?? '' };
						}
						if (f.path.startsWith(variables.fromPath + '/')) {
							return { ...f, path: f.path.replace(variables.fromPath, variables.toPath) };
						}
						return f;
					}),
				);
			}
			// If the renamed file was selected, update the selection
			if (selectedFile === variables.fromPath) {
				setSelectedFile(variables.toPath);
				openFile(variables.toPath);
			}
			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) {
				queryClient.setQueryData(['files', projectId], context.previous);
			}
			toast.error('Failed to rename file');
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
		},
	});

	// Mutation for creating directories
	const createFolderMutation = useMutation({
		mutationFn: async (path: string) => {
			const response = await api.mkdir.$post({
				json: { path },
			});

			if (!response.ok) {
				throw new Error('Failed to create folder');
			}

			return response.json();
		},
		onMutate: async (path) => {
			await queryClient.cancelQueries({ queryKey: ['files', projectId] });
			const previous = queryClient.getQueryData<FileInfo[]>(['files', projectId]);
			if (previous) {
				queryClient.setQueryData<FileInfo[]>(
					['files', projectId],
					[...previous, { path, name: path.split('/').pop() ?? '', isDirectory: true }],
				);
			}
			return { previous };
		},
		onError: (_error, _path, context) => {
			if (context?.previous) {
				queryClient.setQueryData(['files', projectId], context.previous);
			}
			toast.error('Failed to create folder');
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
		},
	});

	// Select a file and open it in the editor
	const selectFile = (path: string) => {
		setSelectedFile(path);
		openFile(path);
	};

	return {
		// State
		files,
		selectedFile,
		expandedDirectories,
		isLoading: query.isLoading,
		isError: query.isError,
		error: query.error,

		// Actions
		selectFile,
		toggleDirectory,
		refetch: query.refetch,

		// Mutations
		createFile: createFileMutation.mutate,
		deleteFile: deleteFileMutation.mutate,
		renameFile: renameFileMutation.mutate,
		createFolder: createFolderMutation.mutate,
		isCreating: createFileMutation.isPending,
		isDeleting: deleteFileMutation.isPending,
		isRenaming: renameFileMutation.isPending,
		isCreatingFolder: createFolderMutation.isPending,
	};
}
