import { useCallback } from 'react';

import { useStore, type SidebarView } from '@/lib/store';
import { normalizeProjectDeepLinkFilePath } from '@shared/project-deep-link';

interface FileLike {
	path: string;
}

interface FileTargetActions {
	expandDirectory: (path: string) => void;
	goToFilePosition: (path: string, position: FileTargetPosition) => void;
	openFile: (path: string) => void;
	setActiveSidebarView: (view: SidebarView) => void;
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
	return normalizeProjectDeepLinkFilePath(path);
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

	// Both goToFilePosition and openFile set the active file, which is the
	// single source of truth for the editor and the tree selection.
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

	return useCallback(
		(target: FileTarget) => {
			openFileTarget(target, files, { expandDirectory, goToFilePosition, openFile, setActiveSidebarView });
		},
		[expandDirectory, files, goToFilePosition, openFile, setActiveSidebarView],
	);
}
