/**
 * Zod validation schemas for the Worker IDE application.
 * Used for both frontend form validation and backend request validation.
 */

import { z } from 'zod';

// =============================================================================
// Validation Constants
// =============================================================================

export const LIMITS = {
	/** Maximum file path length */
	PATH_MAX_LENGTH: 500,
	/** Maximum file content size in bytes */
	FILE_MAX_SIZE: 5 * 1024 * 1024, // 5MB
	/** Maximum AI message length */
	AI_MESSAGE_MAX_LENGTH: 50_000,
	/** Maximum session ID length */
	SESSION_ID_MAX_LENGTH: 32,
	/** Maximum snapshot ID length */
	SNAPSHOT_ID_MAX_LENGTH: 64,
	/** Maximum label length */
	LABEL_MAX_LENGTH: 200,
} as const;

// =============================================================================
// File Path Schemas
// =============================================================================

/**
 * Schema for validating file paths
 * Must start with / and not contain ..
 */
export const filePathSchema = z
	.string()
	.min(1, 'Path is required')
	.max(LIMITS.PATH_MAX_LENGTH, `Path must be at most ${LIMITS.PATH_MAX_LENGTH} characters`)
	.startsWith('/', 'Path must start with /')
	.refine((path) => !path.includes('..'), 'Path cannot contain ".."')
	.refine((path) => path === path.replaceAll(/\/+/g, '/'), 'Path cannot contain consecutive slashes');

/**
 * Schema for file content
 */
export const fileContentSchema = z.string().max(LIMITS.FILE_MAX_SIZE, `File content exceeds maximum size`);

// =============================================================================
// File Operation Schemas
// =============================================================================

/**
 * Schema for writing a file
 */
export const writeFileSchema = z.object({
	path: filePathSchema,
	content: fileContentSchema,
});

export type WriteFileInput = z.infer<typeof writeFileSchema>;

/**
 * Schema for deleting a file
 */
export const deleteFileSchema = z.object({
	path: filePathSchema,
});

export type DeleteFileInput = z.infer<typeof deleteFileSchema>;

/**
 * Schema for creating a directory
 */
export const mkdirSchema = z.object({
	path: filePathSchema,
});

export type MkdirInput = z.infer<typeof mkdirSchema>;

/**
 * Schema for moving/renaming a file
 */
export const moveFileSchema = z.object({
	from_path: filePathSchema,
	to_path: filePathSchema,
});

export type MoveFileInput = z.infer<typeof moveFileSchema>;

// =============================================================================
// AI Agent Schemas
// =============================================================================

/**
 * Schema for AI tool: list_files
 */
export const listFilesInputSchema = z.object({});

/**
 * Schema for AI tool: read_file
 */
export const readFileInputSchema = z.object({
	path: filePathSchema,
});

/**
 * Schema for AI tool: write_file
 */
export const writeFileInputSchema = z.object({
	path: filePathSchema,
	content: z.string(),
});

/**
 * Schema for AI tool: delete_file
 */
export const deleteFileInputSchema = z.object({
	path: filePathSchema,
});

/**
 * Schema for AI tool: move_file
 */
export const moveFileInputSchema = z.object({
	from_path: filePathSchema,
	to_path: filePathSchema,
});

/**
 * Schema for AI tool: search_cloudflare_docs
 */
export const searchCloudflareDocumentationInputSchema = z.object({
	query: z.string().min(1, 'Query is required'),
});

/**
 * Schema for a single TODO item
 */
export const todoItemSchema = z.object({
	id: z.string().min(1),
	content: z.string().min(1),
	status: z.enum(['pending', 'in_progress', 'completed']),
	priority: z.enum(['high', 'medium', 'low']),
});

/**
 * Schema for AI tool: update_plan
 */
export const updatePlanInputSchema = z.object({
	content: z.string().min(1, 'Plan content is required'),
});

/**
 * Schema for AI tool: get_todos
 */
export const getTodosInputSchema = z.object({});

/**
 * Schema for AI tool: update_todos
 */
export const updateTodosInputSchema = z.object({
	todos: z.array(todoItemSchema),
});

/**
 * Schema for AI tool: edit (exact string replacement)
 */
export const editInputSchema = z.object({
	path: filePathSchema,
	old_string: z.string().min(1, 'old_string is required'),
	new_string: z.string(),
	replace_all: z.string().optional(),
});

/**
 * Schema for AI tool: grep (regex search)
 */
export const grepInputSchema = z.object({
	pattern: z.string().min(1, 'Pattern is required'),
	path: z.string().optional(),
	include: z.string().optional(),
	fixed_strings: z.string().optional(),
});

/**
 * Schema for AI tool: glob (find files by pattern)
 */
export const globInputSchema = z.object({
	pattern: z.string().min(1, 'Pattern is required'),
	path: z.string().optional(),
});

/**
 * Schema for AI tool: list (directory listing)
 */
export const listInputSchema = z.object({
	path: z.string().optional(),
	pattern: z.string().optional(),
});

/**
 * Schema for AI tool: patch (apply unified diff)
 */
export const patchInputSchema = z.object({
	path: filePathSchema,
	patch: z.string().min(1, 'Patch content is required'),
});

/**
 * Schema for AI tool: question (ask the user)
 */
export const questionInputSchema = z.object({
	question: z.string().min(1, 'Question is required'),
	options: z.string().optional(),
});

/**
 * Schema for AI tool: webfetch (fetch web content)
 */
export const webfetchInputSchema = z.object({
	url: z.string().url('Must be a valid URL'),
	max_length: z.string().optional(),
});

/**
 * Union of all tool input schemas
 */
export const toolInputSchemas = {
	file_edit: editInputSchema,
	file_write: writeFileInputSchema,
	file_read: readFileInputSchema,
	file_grep: grepInputSchema,
	file_glob: globInputSchema,
	file_list: listInputSchema,
	files_list: listFilesInputSchema,
	file_patch: patchInputSchema,
	file_delete: deleteFileInputSchema,
	file_move: moveFileInputSchema,
	user_question: questionInputSchema,
	web_fetch: webfetchInputSchema,
	docs_search: searchCloudflareDocumentationInputSchema,
	plan_update: updatePlanInputSchema,
	todos_get: getTodosInputSchema,
	todos_update: updateTodosInputSchema,
} as const;

export type ToolName = keyof typeof toolInputSchemas;

/**
 * Schema for AI chat message
 */
export const aiChatMessageSchema = z.object({
	message: z.string().min(1, 'Message is required').max(LIMITS.AI_MESSAGE_MAX_LENGTH, 'Message is too long'),
	history: z.array(z.unknown()).optional(),
	mode: z.enum(['code', 'plan', 'ask']).optional(),
	sessionId: z.string().max(LIMITS.SESSION_ID_MAX_LENGTH).optional(),
});

export type AiChatInput = z.infer<typeof aiChatMessageSchema>;

// =============================================================================
// Session Schemas
// =============================================================================

/**
 * Schema for session ID (alphanumeric only)
 */
export const sessionIdSchema = z
	.string()
	.min(1, 'Session ID is required')
	.max(LIMITS.SESSION_ID_MAX_LENGTH, `Session ID must be at most ${LIMITS.SESSION_ID_MAX_LENGTH} characters`)
	.regex(/^[a-z0-9]+$/, 'Session ID must contain only lowercase alphanumeric characters');

/**
 * Schema for saving an AI session
 */
export const saveSessionSchema = z.object({
	id: sessionIdSchema,
	label: z.string().min(1).max(LIMITS.LABEL_MAX_LENGTH),
	history: z.array(z.unknown()),
	createdAt: z.number(),
	messageSnapshots: z.record(z.string(), z.string()).optional(),
});

export type SaveSessionInput = z.infer<typeof saveSessionSchema>;

// =============================================================================
// Snapshot Schemas
// =============================================================================

/**
 * Schema for snapshot ID (hexadecimal)
 */
export const snapshotIdSchema = z
	.string()
	.min(1, 'Snapshot ID is required')
	.max(LIMITS.SNAPSHOT_ID_MAX_LENGTH, `Snapshot ID must be at most ${LIMITS.SNAPSHOT_ID_MAX_LENGTH} characters`)
	.regex(/^[a-f0-9]+$/, 'Snapshot ID must be a valid hexadecimal string');

/**
 * Schema for reverting a single file from a snapshot
 */
export const revertFileSchema = z.object({
	path: filePathSchema,
	snapshotId: snapshotIdSchema,
});

export type RevertFileInput = z.infer<typeof revertFileSchema>;

// =============================================================================
// Project Meta Schemas
// =============================================================================

/**
 * Schema for updating project metadata (name)
 */
export const projectMetaSchema = z.object({
	name: z.string().min(1, 'Name is required').max(60, 'Name must be at most 60 characters'),
});

export type ProjectMetaInput = z.infer<typeof projectMetaSchema>;

// =============================================================================
// Transform Schemas
// =============================================================================

/**
 * Schema for code transformation request
 */
export const transformCodeSchema = z.object({
	code: z.string(),
	filename: z.string(),
});

export type TransformCodeInput = z.infer<typeof transformCodeSchema>;

// =============================================================================
// Query Parameter Schemas
// =============================================================================

/**
 * Schema for file path query parameter
 */
export const pathQuerySchema = z.object({
	path: filePathSchema,
});

/**
 * Schema for session ID query parameter
 */
export const sessionIdQuerySchema = z.object({
	id: sessionIdSchema,
});

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate tool input based on tool name
 */
export function validateToolInput(
	toolName: ToolName,
	input: unknown,
): { success: true; data: unknown } | { success: false; error: string } {
	const schema = toolInputSchemas[toolName];
	if (!schema) {
		return { success: false, error: `Unknown tool: ${toolName}` };
	}

	const result = schema.safeParse(input);
	if (!result.success) {
		const formatted = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
		return { success: false, error: `Invalid input for ${toolName}: ${formatted}` };
	}

	return { success: true, data: result.data };
}

/**
 * Check if a path is safe (doesn't escape the project root)
 */
export function isPathSafe(path: string): boolean {
	const result = filePathSchema.safeParse(path);
	return result.success;
}
