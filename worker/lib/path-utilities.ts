/**
 * Path utility functions for file operations.
 */

import fs from 'node:fs/promises';

import { BINARY_EXTENSIONS, HIDDEN_ENTRIES, PROTECTED_FILES } from '@shared/constants';

/**
 * Check if a path is safe (doesn't escape the project root).
 */
export function isPathSafe(_basePath: string, requestedPath: string): boolean {
	if (typeof requestedPath !== 'string') return false;
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

/**
 * When a file is not found, list the parent directory and suggest files with
 * similar names (case-insensitive match or close edit distance). Returns a
 * human-readable suggestion string like:
 *   `Did you mean "/src/app.tsx"?`
 * or an empty string if no similar files are found.
 *
 * This is used in tool error messages so the model can self-correct.
 */
export async function suggestSimilarFiles(projectRoot: string, requestedPath: string): Promise<string> {
	try {
		const lastSlash = requestedPath.lastIndexOf('/');
		const directory = lastSlash <= 0 ? '/' : requestedPath.slice(0, lastSlash);
		const fileName = requestedPath.slice(lastSlash + 1).toLowerCase();

		if (!fileName) return '';

		const entries = await fs.readdir(`${projectRoot}${directory}`).catch(() => []);
		if (entries.length === 0) return '';

		// Find case-insensitive matches first (most common mistake)
		const caseMatch = entries.find((entry) => entry.toLowerCase() === fileName && entry !== requestedPath.slice(lastSlash + 1));
		if (caseMatch) {
			return `Did you mean "${directory === '/' ? '' : directory}/${caseMatch}"?`;
		}

		// Find entries with the same base name but different extension, or vice versa
		const requestedBase = fileName.includes('.') ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName;
		const extensionMatches = entries.filter((entry) => {
			const entryLower = entry.toLowerCase();
			const entryBase = entryLower.includes('.') ? entryLower.slice(0, entryLower.lastIndexOf('.')) : entryLower;
			return entryBase === requestedBase && entryLower !== fileName;
		});

		if (extensionMatches.length > 0) {
			const suggestions = extensionMatches
				.slice(0, 3)
				.map((entry) => `"${directory === '/' ? '' : directory}/${entry}"`)
				.join(', ');
			return `Did you mean ${suggestions}?`;
		}

		return '';
	} catch {
		return '';
	}
}
