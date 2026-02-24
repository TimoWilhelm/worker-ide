/**
 * Shared type definitions for the Worker IDE application.
 * These types are used by both the frontend and worker backend.
 */

// =============================================================================
// File System Types
// =============================================================================

/**
 * Represents a file in the project filesystem
 */
export interface FileInfo {
	/** Absolute path from project root (e.g., "/src/main.ts") */
	path: string;
	/** File name without path */
	name: string;
	/** Whether this is a directory */
	isDirectory: boolean;
}

/**
 * A tree node for rendering the file tree
 */
export interface FileTreeNode {
	path: string;
	name: string;
	isDirectory: boolean;
	children?: FileTreeNode[];
	/** Depth level for indentation */
	level: number;
}

// =============================================================================
// Editor Types
// =============================================================================

/**
 * Represents an open file in the editor tabs
 */
export interface OpenFile {
	path: string;
	content: string;
	/** Whether the file has unsaved changes */
	isDirty: boolean;
	/** Cursor position */
	cursor?: CursorPosition;
}

/**
 * Cursor position in the editor
 */
export interface CursorPosition {
	line: number;
	ch: number;
}

/**
 * Selection range in the editor
 */
export interface SelectionRange {
	anchor: CursorPosition;
	head: CursorPosition;
}

// =============================================================================
// AI Agent Types
// =============================================================================

/**
 * Re-export UIMessage from TanStack AI for use throughout the app.
 * This is the primary message type for the AI chat interface.
 */
export type { UIMessage } from '@tanstack/ai-client';

/**
 * Agent operating mode.
 * - code: Full tool access — reads, writes, edits, deletes files (default).
 * - plan: Read-only research + produces an implementation plan.
 * - ask: No tools — conversational Q&A only.
 */
export type AgentMode = 'code' | 'plan' | 'ask';

/**
 * Structured tool error info received via CUSTOM AG-UI `tool_error` events.
 * Replaces regex-based `[CODE] message` prefix parsing on the frontend.
 */
export interface ToolErrorInfo {
	toolCallId: string;
	toolName: string;
	/** Error code from ToolErrorCode (e.g. "FILE_NOT_FOUND"), or empty string for non-tool errors */
	errorCode: string;
	/** Human-readable error message without the [CODE] prefix */
	errorMessage: string;
}

/**
 * A saved AI chat session.
 * Uses UIMessage[] from TanStack AI for the history.
 */
export interface AiSession {
	id: string;
	label: string;
	createdAt: number;
	history: unknown[];
	/** Maps message index (as string key) to snapshot ID for revert buttons */
	messageSnapshots?: Record<string, string>;
	/** Last known context window token usage (for the context ring indicator) */
	contextTokensUsed?: number;
	/** Set by the client after a revert to prevent the server-side stream
	 *  `finally` block from overwriting the truncated history. */
	revertedAt?: number;
}

/**
 * Summary of a saved session (without full history)
 */
export interface AiSessionSummary {
	id: string;
	label: string;
	createdAt: number;
}

// =============================================================================
// TODO Item Types
// =============================================================================

/**
 * A TODO item tracked by the AI agent for a session
 */
export interface TodoItem {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	priority: 'high' | 'medium' | 'low';
}

// =============================================================================
// Pending AI Change Types
// =============================================================================

/**
 * A file change made by the AI that is pending user review.
 * The AI writes files immediately (for HMR preview), but the user
 * can approve (keep) or reject (revert) each change.
 */
export interface PendingFileChange {
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	snapshotId: string | undefined;
	status: 'pending' | 'approved' | 'rejected';
	/**
	 * Per-change-group statuses for hunk-level accept/reject.
	 * Indices correspond to change groups computed by `groupHunksIntoChanges()`.
	 * Starts as `[]` and is populated when the diff is first displayed.
	 */
	hunkStatuses: Array<'pending' | 'approved' | 'rejected'>;
	/** The AI session that produced this change */
	sessionId: string;
}

// =============================================================================
// Snapshot Types
// =============================================================================

/**
 * A file change recorded in a snapshot
 */
export interface FileChange {
	path: string;
	action: 'create' | 'edit' | 'delete';
	beforeContent: string | null;
	afterContent: string | null;
	isBinary: boolean;
}

/**
 * Full metadata for a snapshot (used in detail views)
 */
export interface SnapshotMetadata {
	id: string;
	timestamp: number;
	label: string;
	/** The AI session that created this snapshot (absent in legacy snapshots) */
	sessionId?: string;
	changes: Array<{
		path: string;
		action: 'create' | 'edit' | 'delete';
	}>;
}

/**
 * Summary metadata for a snapshot (used in list views, no changes array)
 */
export interface SnapshotSummary {
	id: string;
	timestamp: number;
	label: string;
	changeCount: number;
}

// =============================================================================
// Collaboration Types
// =============================================================================

/**
 * A participant in the collaborative editing session
 */
export interface Participant {
	id: string;
	color: string;
	file: string | null;
	cursor: CursorPosition | null;
	selection: SelectionRange | null;
}

// =============================================================================
// HMR Types
// =============================================================================

/**
 * An HMR update message
 */
export interface HmrUpdate {
	type: 'update' | 'full-reload';
	path: string;
	timestamp: number;
	isCSS?: boolean;
}

// =============================================================================
// Server Error Types
// =============================================================================

/**
 * A structured dependency resolution error.
 */
export interface DependencyError {
	/** The npm package name (e.g. "react", "@scope/pkg") */
	packageName: string;
	/** The kind of dependency problem */
	code: 'unregistered' | 'not-found' | 'resolve-failed';
	/** Human-readable description */
	message: string;
}

/**
 * An error from the server-side code execution
 */
export interface ServerError {
	/** Unique identifier for deduplication across channels */
	id: string;
	timestamp: number;
	type: 'bundle' | 'runtime';
	message: string;
	file?: string;
	line?: number;
	column?: number;
	/** Structured dependency errors extracted from the build, if any */
	dependencyErrors?: DependencyError[];
}

/**
 * A log entry from the server
 */
export interface ServerLogEntry {
	type: 'server-log';
	timestamp: number;
	level: 'log' | 'warning' | 'error' | 'debug' | 'info';
	message: string;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Generic API response wrapper
 */
export interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: string;
}

/**
 * Response for file list endpoint
 */
export interface FilesResponse {
	files: FileInfo[];
}

/**
 * Response for file content endpoint
 */
export interface FileResponse {
	path: string;
	content: string;
}

/**
 * Response for project expiration endpoint
 */
export interface ExpirationResponse {
	expiresAt: number | null;
	expiresIn: number | null;
}

/**
 * Response for new project endpoint
 */
export interface NewProjectResponse {
	projectId: string;
	url: string;
	name: string;
}

/**
 * Project metadata stored in .project-meta.json
 */
export interface ProjectMeta {
	name: string;
	humanId: string;
	dependencies?: Record<string, string>;
}

// =============================================================================
// Git Types
// =============================================================================

/**
 * Possible status values for a file in the git working tree.
 *
 * The values map to isomorphic-git statusMatrix [HEAD, WORKDIR, STAGE]:
 * - untracked:                [0, 2, 0] — new file not yet staged
 * - untracked-staged:         [0, 2, 2] — new file, fully staged
 * - untracked-partially-staged: [0, 2, 3] — new file, staged version differs from working
 * - unmodified:               [1, 1, 1] — clean, committed
 * - modified:                 [1, 2, 1] — modified in workdir, not staged
 * - modified-staged:          [1, 2, 2] — modified, fully staged
 * - modified-partially-staged: [1, 2, 3] — modified, staged version differs from working
 * - deleted:                  [1, 0, 1] — deleted in workdir, not staged
 * - deleted-staged:           [1, 0, 0] — deleted, staged for removal
 * - added:                    [0, 2, 2] — alias for untracked-staged in simplified views
 */
export type GitFileStatus =
	| 'untracked'
	| 'untracked-staged'
	| 'untracked-partially-staged'
	| 'unmodified'
	| 'modified'
	| 'modified-staged'
	| 'modified-partially-staged'
	| 'deleted'
	| 'deleted-staged';

/**
 * A single entry from the git status matrix.
 */
export interface GitStatusEntry {
	/** File path relative to project root (e.g. "src/main.tsx") */
	path: string;
	/** Human-friendly status label */
	status: GitFileStatus;
	/** Whether this entry appears in the staging area */
	staged: boolean;
	/** Raw HEAD status code from statusMatrix */
	headStatus: number;
	/** Raw working directory status code from statusMatrix */
	workdirStatus: number;
	/** Raw staging area status code from statusMatrix */
	stageStatus: number;
}

/**
 * Information about a git branch.
 */
export interface GitBranchInfo {
	/** Branch name (e.g. "main", "feature/dark-mode") */
	name: string;
	/** Whether this is the currently checked-out branch */
	isCurrent: boolean;
}

/**
 * Author information for a git commit.
 */
export interface GitAuthor {
	name: string;
	email: string;
	timestamp: number;
}

/**
 * A single commit entry from git log.
 */
export interface GitCommitEntry {
	/** Full object ID (SHA-1 hash) */
	objectId: string;
	/** Abbreviated object ID (first 7 characters) */
	abbreviatedObjectId: string;
	/** Commit message (full) */
	message: string;
	/** Author information */
	author: GitAuthor;
	/** Parent commit OIDs */
	parentObjectIds: string[];
}

/**
 * A connection line in the commit graph visualization.
 */
export interface GitGraphConnection {
	fromColumn: number;
	toColumn: number;
	color: string;
}

/**
 * A commit entry augmented with graph layout information.
 */
export interface GitGraphEntry extends GitCommitEntry {
	/** Column index for this commit in the graph */
	column: number;
	/** Lines connecting to parent commits */
	connections: GitGraphConnection[];
	/** Branch names pointing at this commit */
	branchNames: string[];
	/** Tag names pointing at this commit */
	tagNames: string[];
}

/**
 * A single line in a diff hunk.
 */
export interface GitDiffLine {
	type: 'add' | 'remove' | 'context';
	content: string;
}

/**
 * A hunk in a file diff.
 */
export interface GitDiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: GitDiffLine[];
}

/**
 * A diff for a single file.
 */
export interface GitFileDiff {
	path: string;
	status: 'modified' | 'added' | 'deleted';
	hunks: GitDiffHunk[];
	/** Raw content before the change (HEAD version). Empty string for new files. */
	beforeContent?: string;
	/** Raw content after the change (working directory version). Empty string for deleted files. */
	afterContent?: string;
}

/**
 * A stash entry.
 */
export interface GitStashEntry {
	index: number;
	message: string;
	objectId: string;
}

/**
 * Result of a merge operation.
 */
export interface GitMergeResult {
	/** Resulting commit OID if the merge was committed */
	objectId?: string;
	/** True if the branches were already merged */
	alreadyMerged?: boolean;
	/** True if the merge was a fast-forward */
	fastForward?: boolean;
	/** Paths with conflicts, if any */
	conflicts?: string[];
}
