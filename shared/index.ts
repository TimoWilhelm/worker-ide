/**
 * Shared module exports
 * Re-exports all shared types, constants, validation schemas, and utilities.
 */

// Types - all type definitions
export * from './types';

// Constants - shared configuration values
export * from './constants';

// Errors - error codes and handling
export * from './errors';

// Validation - Zod schemas (export with explicit names to avoid conflicts)
export {
	// Schemas
	filePathSchema,
	fileContentSchema,
	writeFileSchema,
	deleteFileSchema,
	mkdirSchema,
	moveFileSchema,
	listFilesInputSchema,
	readFileInputSchema,
	writeFileInputSchema,
	deleteFileInputSchema,
	moveFileInputSchema,
	toolInputSchemas,
	aiChatMessageSchema,
	sessionIdSchema,
	saveSessionSchema,
	snapshotIdSchema,
	revertFileSchema,
	transformCodeSchema,
	pathQuerySchema,
	sessionIdQuerySchema,
	// Types (with explicit renames to avoid conflicts)
	type WriteFileInput as WriteFileSchemaInput,
	type DeleteFileInput as DeleteFileSchemaInput,
	type MoveFileInput as MoveFileSchemaInput,
	type MkdirInput,
	type AiChatInput,
	type SaveSessionInput,
	type RevertFileInput,
	type TransformCodeInput,
	// Helpers
	validateToolInput,
	isPathSafe,
	LIMITS,
	// ToolName type is used by validation
	type ToolName as ValidationToolName,
} from './validation';

// WebSocket messages
export * from './ws-messages';
