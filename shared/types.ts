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
export type ToolName = 'list_files' | 'read_file' | 'write_file' | 'delete_file' | 'move_file';

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

export type ToolInput =
	| { name: 'list_files'; input: ListFilesInput }
	| { name: 'read_file'; input: ReadFileInput }
	| { name: 'write_file'; input: WriteFileInput }
	| { name: 'delete_file'; input: DeleteFileInput }
	| { name: 'move_file'; input: MoveFileInput };

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
