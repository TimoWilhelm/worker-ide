/**
 * useFileTree Hook
 *
 * Hook for loading and managing file tree state.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

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
// Utilities
// =============================================================================

/**
 * Extract filename from path.
 */
function getFilename(path: string): string {
	const parts = path.split('/');
	return parts.at(-1) || path;
}

/**
 * Convert file path to FileInfo.
 */
function pathToFileInfo(path: string): FileInfo {
	return {
		path,
		name: getFilename(path),
		isDirectory: false,
	};
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

			const data: { files: string[] } = await response.json();
			return data.files;
		},
		enabled,
		staleTime: 1000 * 30, // 30 seconds
	});

	// Sync query data with store
	useEffect(() => {
		if (query.data) {
			setFiles(query.data.map((path) => pathToFileInfo(path)));
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
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
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
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['files', projectId] });
		},
	});

	// Select a file and open it in the editor
	const selectFile = (path: string) => {
		setSelectedFile(path);
		openFile(path);
	};

	// Get file paths as flat array
	const filePaths = files.map((file) => file.path);

	return {
		// State
		files: filePaths,
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
		isCreating: createFileMutation.isPending,
		isDeleting: deleteFileMutation.isPending,
	};
}
