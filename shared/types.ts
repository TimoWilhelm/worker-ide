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
 * A message in the AI chat conversation
 */
export interface AgentMessage {
	role: 'user' | 'assistant';
	content: AgentContent[];
}

/**
 * Content blocks in an AI message
 */
export type AgentContent = TextContent | ToolUseContent | ToolResultContent;

export interface TextContent {
	type: 'text';
	text: string;
}

export interface ToolUseContent {
	type: 'tool_use';
	id: string;
	name: ToolName;
	input: Record<string, unknown>;
}

export interface ToolResultContent {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

/**
 * Available tools for the AI agent
 */
export type ToolName =
	| 'file_edit'
	| 'file_write'
	| 'file_read'
	| 'file_grep'
	| 'file_glob'
	| 'file_list'
	| 'files_list'
	| 'file_patch'
	| 'file_delete'
	| 'file_move'
	| 'user_question'
	| 'web_fetch'
	| 'docs_search'
	| 'plan_update'
	| 'todos_get'
	| 'todos_update';

/**
 * Tool input types
 */
export type ListFilesInput = Record<string, never>;

export interface ReadFileInput {
	path: string;
}

export interface WriteFileInput {
	path: string;
	content: string;
}

export interface DeleteFileInput {
	path: string;
}

export interface MoveFileInput {
	from_path: string;
	to_path: string;
}

export interface SearchCloudflareDocumentationInput {
	query: string;
}

export interface GetTodosInput {
	sessionId?: string;
}

export interface UpdateTodosInput {
	todos: TodoItem[];
}

export interface UpdatePlanInput {
	content: string;
}

export interface EditInput {
	path: string;
	old_string: string;
	new_string: string;
	replace_all?: string;
}

export interface GrepInput {
	pattern: string;
	path?: string;
	include?: string;
	fixed_strings?: string;
}

export interface GlobInput {
	pattern: string;
	path?: string;
}

export interface ListInput {
	path?: string;
	pattern?: string;
}

export interface PatchInput {
	path: string;
	patch: string;
}

export interface QuestionInput {
	question: string;
	options?: string;
}

export interface WebfetchInput {
	url: string;
	max_length?: string;
}

export type ToolInput =
	| { name: 'edit'; input: EditInput }
	| { name: 'write'; input: WriteFileInput }
	| { name: 'read'; input: ReadFileInput }
	| { name: 'grep'; input: GrepInput }
	| { name: 'glob'; input: GlobInput }
	| { name: 'list'; input: ListInput }
	| { name: 'patch'; input: PatchInput }
	| { name: 'question'; input: QuestionInput }
	| { name: 'webfetch'; input: WebfetchInput }
	| { name: 'list_files'; input: ListFilesInput }
	| { name: 'read_file'; input: ReadFileInput }
	| { name: 'write_file'; input: WriteFileInput }
	| { name: 'delete_file'; input: DeleteFileInput }
	| { name: 'move_file'; input: MoveFileInput }
	| { name: 'search_cloudflare_docs'; input: SearchCloudflareDocumentationInput }
	| { name: 'get_todos'; input: GetTodosInput }
	| { name: 'update_todos'; input: UpdateTodosInput }
	| { name: 'update_plan'; input: UpdatePlanInput };

/**
 * A saved AI chat session
 */
export interface AiSession {
	id: string;
	label: string;
	createdAt: number;
	history: AgentMessage[];
	/** Maps message index (as string key) to snapshot ID for revert buttons */
	messageSnapshots?: Record<string, string>;
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
	action: 'create' | 'edit' | 'delete';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	snapshotId: string | undefined;
	status: 'pending' | 'approved' | 'rejected';
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
 * An error from the server-side code execution
 */
export interface ServerError {
	timestamp: number;
	type: 'bundle' | 'runtime';
	message: string;
	file?: string;
	line?: number;
	column?: number;
}

/**
 * A log entry from the server
 */
export interface ServerLogEntry {
	type: 'server-log';
	timestamp: number;
	level: 'log' | 'warn' | 'error' | 'debug' | 'info';
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
	files: string[];
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
}
