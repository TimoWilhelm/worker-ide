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
	// Git schemas
	gitStageSchema,
	gitDiscardSchema,
	gitCommitSchema,
	gitBranchSchema,
	gitBranchRenameSchema,
	gitCheckoutSchema,
	gitMergeSchema,
	gitTagSchema,
	gitStashSchema,
	gitLogQuerySchema,
	gitGraphQuerySchema,
	gitDiffQuerySchema,
	gitCommitDiffQuerySchema,
	gitBranchNameQuerySchema,
	gitTagNameQuerySchema,
	// Types
	type WriteFileInput,
	type DeleteFileInput,
	type MoveFileInput,
	type MkdirInput,
	type AiChatInput,
	type SaveSessionInput,
	type RevertFileInput,
	type TransformCodeInput,
	type GitStageInput,
	type GitDiscardInput,
	type GitCommitInput,
	type GitBranchInput,
	type GitBranchRenameInput,
	type GitCheckoutInput,
	type GitMergeInput,
	type GitTagInput,
	type GitStashInput,
	type GitLogQuery,
	type GitGraphQuery,
	type GitDiffQuery,
	type GitCommitDiffQuery,
	// Helpers
	validateToolInput,
	isPathSafe,
	LIMITS,
	type ToolName,
} from './validation';

// WebSocket messages
export * from './ws-messages';
