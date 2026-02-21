/**
 * Path utility functions for file operations.
 */

import { BINARY_EXTENSIONS, HIDDEN_ENTRIES, PROTECTED_FILES } from '@shared/constants';

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
 * Check if a path targets a hidden entry (e.g. .git, .agent, .initialized).
 * Returns true when any segment of the path is in HIDDEN_ENTRIES.
 */
export function isHiddenPath(requestedPath: string): boolean {
	const segments = requestedPath.split('/');
	return segments.some((segment) => HIDDEN_ENTRIES.has(segment));
}

/**
 * Check if a file is protected and cannot be deleted.
 */
export function isProtectedFile(path: string): boolean {
	// Exact match check
	if (PROTECTED_FILES.has(path)) {
		return true;
	}

	// Be safe and check if we are deleting a parent directory of a protected file
	// e.g. path='/worker' contains protected '/worker/index.ts'
	for (const protectedPath of PROTECTED_FILES) {
		if (protectedPath.startsWith(`${path}/`)) {
			return true;
		}
	}

	return false;
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
