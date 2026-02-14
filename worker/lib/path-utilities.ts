/**
 * Path utility functions for file operations.
 */

import { BINARY_EXTENSIONS, PROTECTED_FILES } from '@shared/constants';

/**
 * Check if a path is safe (doesn't escape the project root).
 */
export function isPathSafe(_basePath: string, requestedPath: string): boolean {
	if (!requestedPath.startsWith('/')) {
		return false;
	}
	if (requestedPath.includes('..')) {
		return false;
	}
	const normalizedPath = requestedPath.replaceAll(/\/+/g, '/');
	if (requestedPath !== normalizedPath) {
		return false;
	}
	return true;
}

/**
 * Check if a file is protected and cannot be deleted.
 */
export function isProtectedFile(path: string): boolean {
	return PROTECTED_FILES.has(path);
}

/**
 * Get the file extension from a path.
 */
export function getExtension(path: string): string {
	const match = path.match(/\.[^.]+$/);
	return match ? match[0].toLowerCase() : '';
}

/**
 * Check if a file is binary based on its extension.
 */
export function isBinaryFile(path: string): boolean {
	const extension = getExtension(path);
	return BINARY_EXTENSIONS.has(extension);
}
