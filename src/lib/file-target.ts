import { useCallback } from 'react';

import { useStore, type SidebarView } from '@/lib/store';

interface FileLike {
	path: string;
}

interface FileTargetActions {
	expandDirectory: (path: string) => void;
	goToFilePosition: (path: string, position: FileTargetPosition) => void;
	openFile: (path: string) => void;
	setActiveSidebarView: (view: SidebarView) => void;
	setSelectedFile: (path: string | undefined) => void;
}

export interface FileTargetPosition {
	line: number;
	column: number;
}

export interface FileTarget {
	path: string;
	position?: FileTargetPosition;
}

function normalizeFileTargetPath(path: string): string {
	if (path.startsWith('/')) {
		return path;
	}

	return `/${path.replace(/^\.?\//, '')}`;
}

export function resolveFileTargetPath(path: string, files: readonly FileLike[]): string {
	return files.find((file) => file.path === path)?.path ?? normalizeFileTargetPath(path);
}

function getFileTargetParentDirectories(path: string): string[] {
	const pathParts = path.split('/').filter(Boolean);
	const directories: string[] = [];
	let currentPath = '';

	for (const pathPart of pathParts.slice(0, -1)) {
		currentPath += `/${pathPart}`;
		directories.push(currentPath);
	}

	return directories;
}

export function openFileTarget(target: FileTarget, files: readonly FileLike[], actions: FileTargetActions): void {
	const resolvedPath = resolveFileTargetPath(target.path, files);

	actions.setActiveSidebarView('explorer');
	for (const directoryPath of getFileTargetParentDirectories(resolvedPath)) {
		actions.expandDirectory(directoryPath);
	}
	actions.setSelectedFile(resolvedPath);

	if (target.position) {
		actions.goToFilePosition(resolvedPath, target.position);
		return;
	}

	actions.openFile(resolvedPath);
}

export function useFileTargetOpener(): (target: FileTarget) => void {
	const expandDirectory = useStore((state) => state.expandDirectory);
	const files = useStore((state) => state.files);
	const goToFilePosition = useStore((state) => state.goToFilePosition);
	const openFile = useStore((state) => state.openFile);
	const setActiveSidebarView = useStore((state) => state.setActiveSidebarView);
	const setSelectedFile = useStore((state) => state.setSelectedFile);

	return useCallback(
		(target: FileTarget) => {
			openFileTarget(target, files, { expandDirectory, goToFilePosition, openFile, setActiveSidebarView, setSelectedFile });
		},
		[expandDirectory, files, goToFilePosition, openFile, setActiveSidebarView, setSelectedFile],
	);
}
