/**
 * Editor Session Persistence (localStorage)
 *
 * Saves and restores per-project editor state: open tabs, active file,
 * and per-file scroll positions.
 * Scoped to each project via `worker-ide-editor-session:<projectId>`.
 */

import { editorSessionSchema } from '@shared/validation';

import type { EditorSessionParsed } from '@shared/validation';

/**
 * localStorage key for the editor session, scoped per project.
 */
function editorSessionKey(projectId: string): string {
	return `worker-ide-editor-session:${projectId}`;
}

/**
 * Load the persisted editor session for a project.
 * Returns `undefined` if nothing is stored or the data is malformed.
 */
export function loadEditorSession(projectId: string): EditorSessionParsed | undefined {
	try {
		const raw = localStorage.getItem(editorSessionKey(projectId));
		if (!raw) return undefined;

		const parsed: unknown = JSON.parse(raw);
		const result = editorSessionSchema.safeParse(parsed);
		if (result.success) {
			return result.data;
		}
	} catch {
		// Corrupt or unavailable — silently ignore
	}
	return undefined;
}

/**
 * Save the editor session for a project to localStorage.
 */
export function saveEditorSession(projectId: string, session: EditorSessionParsed): void {
	try {
		localStorage.setItem(editorSessionKey(projectId), JSON.stringify(session));
	} catch {
		// Storage full or unavailable — silently ignore
	}
}

// =============================================================================
// Resolved session (pure, testable)
// =============================================================================

export interface ResolvedEditorSession {
	openFiles: string[];
	activeFile: string;
	scrollPositions: Map<string, number>;
}

/**
 * Resolve a persisted session against the set of files that actually exist
 * in the project. Filters out deleted files and stale scroll positions,
 * and falls back `activeFile` to the first surviving tab when necessary.
 *
 * Returns `undefined` when there is nothing useful to restore (no session,
 * empty open files, or all files were deleted).
 */
export function resolveEditorSession(
	session: EditorSessionParsed | undefined,
	existingPaths: Set<string>,
): ResolvedEditorSession | undefined {
	if (!session) return undefined;

	const { openFiles, activeFile, scrollPositions } = session;
	if (openFiles.length === 0) return undefined;

	// Keep only files that still exist
	const validOpenFiles = openFiles.filter((filePath) => existingPaths.has(filePath));
	if (validOpenFiles.length === 0) return undefined;

	// Keep only scroll positions for surviving files
	const scrollMap = new Map<string, number>();
	for (const [filePath, scrollTop] of Object.entries(scrollPositions)) {
		if (existingPaths.has(filePath) && validOpenFiles.includes(filePath)) {
			scrollMap.set(filePath, scrollTop);
		}
	}

	const resolvedActiveFile = activeFile && validOpenFiles.includes(activeFile) ? activeFile : validOpenFiles[0];

	return {
		openFiles: validOpenFiles,
		activeFile: resolvedActiveFile,
		scrollPositions: scrollMap,
	};
}
