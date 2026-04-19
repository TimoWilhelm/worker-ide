import { z } from 'zod';

import { AI_MODEL_IDS_TUPLE, DEFAULT_EDITOR_FONT, EDITOR_FONT_SLUGS, MAX_PROJECT_NAME_LENGTH, USER_PREFERENCE_KEYS } from './constants';

export const LIMITS = {
	PATH_MAX_LENGTH: 500,
	FILE_MAX_SIZE: 5 * 1024 * 1024, // 5MB
	SESSION_ID_MAX_LENGTH: 32,
	SNAPSHOT_ID_MAX_LENGTH: 64,
	TITLE_MAX_LENGTH: 100,
} as const;

export const filePathSchema = z
	.string()
	.min(1, 'Path is required')
	.max(LIMITS.PATH_MAX_LENGTH, `Path must be at most ${LIMITS.PATH_MAX_LENGTH} characters`)
	.startsWith('/', 'Path must start with /')
	.refine((path) => !path.includes('..'), 'Path cannot contain ".."')
	.refine((path) => path === path.replaceAll(/\/+/g, '/'), 'Path cannot contain consecutive slashes');
export const fileContentSchema = z.string().max(LIMITS.FILE_MAX_SIZE, `File content exceeds maximum size`);
export const writeFileSchema = z.object({
	path: filePathSchema,
	content: fileContentSchema,
});

export type WriteFileInput = z.infer<typeof writeFileSchema>;
export const deleteFileSchema = z.object({
	path: filePathSchema,
});

export type DeleteFileInput = z.infer<typeof deleteFileSchema>;
export const mkdirSchema = z.object({
	path: filePathSchema,
});

export type MkdirInput = z.infer<typeof mkdirSchema>;
export const moveFileSchema = z.object({
	from_path: filePathSchema,
	to_path: filePathSchema,
});

export type MoveFileInput = z.infer<typeof moveFileSchema>;

export const aiModelSchema = z.enum(AI_MODEL_IDS_TUPLE);
export type AllowedAIModel = z.infer<typeof aiModelSchema>;
export const listFilesInputSchema = z.object({});
export const readFileInputSchema = z.object({
	file_path: filePathSchema,
	offset: z.coerce.number().int().min(1).optional(),
	limit: z.coerce.number().int().min(1).optional(),
});
export const writeFileInputSchema = z.object({
	file_path: filePathSchema,
	content: z.string(),
});
export const deleteFileInputSchema = z.object({
	file_path: filePathSchema,
});
export const moveFileInputSchema = z.object({
	from_path: filePathSchema,
	to_path: filePathSchema,
});
export const searchCloudflareDocumentationInputSchema = z.object({
	query: z.string().min(1, 'Query is required'),
});
export const todoItemSchema = z.object({
	id: z.string().min(1),
	content: z.string().min(1),
	status: z.enum(['pending', 'in_progress', 'completed']),
	priority: z.enum(['high', 'medium', 'low']),
});
export const updatePlanInputSchema = z.object({
	content: z.string().min(1, 'Plan content is required'),
});
export const getTodosInputSchema = z.object({});
export const updateTodosInputSchema = z.object({
	todos: z.array(todoItemSchema),
});
export const editInputSchema = z.object({
	file_path: filePathSchema,
	old_string: z.string().min(1, 'old_string is required'),
	new_string: z.string(),
	replace_all: z.string().optional(),
});
export const multiEditInputSchema = z.object({
	file_path: filePathSchema,
	edits: z.union([
		z.array(
			z.object({
				old_string: z.string().min(1, 'old_string is required'),
				new_string: z.string(),
				replace_all: z.boolean().optional(),
			}),
		),
		z.string().min(1, 'edits JSON array is required'),
	]),
});
export const grepInputSchema = z.object({
	pattern: z.string().min(1, 'Pattern is required'),
	path: z.string().optional(),
	include: z.string().optional(),
});
export const globInputSchema = z.object({
	pattern: z.string().min(1, 'Pattern is required'),
	path: z.string().optional(),
});
export const listInputSchema = z.object({
	path: z.string().optional(),
	pattern: z.string().optional(),
});
export const questionInputSchema = z.object({
	question: z.string().min(1, 'Question is required'),
	options: z.string().optional(),
});
export const webfetchInputSchema = z.object({
	url: z.string().url('Must be a valid URL'),
	prompt: z.string().min(1, 'Prompt is required'),
});
export const dependenciesListInputSchema = z.object({});
export const dependenciesUpdateInputSchema = z.object({
	action: z.enum(['add', 'remove', 'update']),
	name: z.string().min(1, 'Package name is required'),
	version: z.string().optional(),
});
export const assetSettingsGetInputSchema = z.object({});
export const bindingsGetInputSchema = z.object({});
export const bindingsUpdateInputSchema = z.object({
	storage: z.string().optional(),
});
export const assetSettingsUpdateInputSchema = z.object({
	not_found_handling: z.string().optional(),
	html_handling: z.string().optional(),
	run_worker_first: z.string().optional(),
});
export const lintCheckInputSchema = z.object({
	path: filePathSchema,
});
export const lintFixInputSchema = z.object({
	path: filePathSchema,
});

export const cdpEvalInputSchema = z.object({
	method: z.string().min(1, 'CDP method is required'),
	params: z.string().optional(),
});
export const previewFetchInputSchema = z.object({
	path: z.string().min(1, 'Path is required'),
	method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
	headers: z.string().optional(),
	body: z.string().optional(),
	format: z.enum(['raw', 'markdown']).optional(),
});
export const testRunInputSchema = z.object({
	pattern: z.string().optional(),
	testName: z.string().optional(),
});
export const imageGenerateInputSchema = z.object({
	prompt: z.string().min(1, 'Prompt is required'),
	path: filePathSchema,
});
export const subAgentInputSchema = z.object({
	prompt: z.string().min(1, 'Prompt is required'),
	context: z.string().optional(),
});

export const executeInputSchema = z.object({
	code: z.string().min(1, 'Code is required'),
});

export const browserSearchInputSchema = z.object({
	code: z.string().min(1, 'Code is required'),
});

export const browserExecuteInputSchema = z.object({
	code: z.string().min(1, 'Code is required'),
});

export const loadExtensionInputSchema = z.object({
	name: z.string().min(1, 'Name is required'),
	version: z.string().min(1, 'Version is required'),
	source: z.string().min(1, 'Source is required'),
	description: z.string().optional(),
	workspace_access: z.enum(['none', 'read', 'read-write']).optional(),
	network: z.array(z.string()).optional(),
});

export const listExtensionsInputSchema = z.object({});
export const toolInputSchemas = {
	file_edit: editInputSchema,
	file_multiedit: multiEditInputSchema,
	file_write: writeFileInputSchema,
	file_read: readFileInputSchema,
	file_grep: grepInputSchema,
	file_glob: globInputSchema,
	file_list: listInputSchema,
	files_list: listFilesInputSchema,

	file_delete: deleteFileInputSchema,
	file_move: moveFileInputSchema,
	user_question: questionInputSchema,
	web_fetch: webfetchInputSchema,
	docs_search: searchCloudflareDocumentationInputSchema,
	plan_update: updatePlanInputSchema,
	todos_get: getTodosInputSchema,
	todos_update: updateTodosInputSchema,
	dependencies_list: dependenciesListInputSchema,
	dependencies_update: dependenciesUpdateInputSchema,
	asset_settings_get: assetSettingsGetInputSchema,
	asset_settings_update: assetSettingsUpdateInputSchema,
	bindings_get: bindingsGetInputSchema,
	bindings_update: bindingsUpdateInputSchema,
	lint_check: lintCheckInputSchema,
	lint_fix: lintFixInputSchema,
	cdp_eval: cdpEvalInputSchema,
	preview_fetch: previewFetchInputSchema,
	test_run: testRunInputSchema,
	image_generate: imageGenerateInputSchema,
	sub_agent: subAgentInputSchema,
	execute: executeInputSchema,
	browser_search: browserSearchInputSchema,
	browser_execute: browserExecuteInputSchema,
	load_extension: loadExtensionInputSchema,
	list_extensions: listExtensionsInputSchema,
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export const sessionIdSchema = z
	.string()
	.min(1, 'Session ID is required')
	.max(LIMITS.SESSION_ID_MAX_LENGTH, `Session ID must be at most ${LIMITS.SESSION_ID_MAX_LENGTH} characters`)
	.regex(/^[a-z0-9]+$/, 'Session ID must contain only lowercase alphanumeric characters');
export const sessionTitleSchema = z
	.string()
	.trim()
	.min(1, 'Title is required')
	.max(LIMITS.TITLE_MAX_LENGTH, `Title must be at most ${LIMITS.TITLE_MAX_LENGTH} characters`);
export const pendingFileChangeSchema = z.object({
	path: z.string(),
	action: z.enum(['create', 'edit', 'delete', 'move']),
	beforeContent: z
		.string()
		.optional()
		.transform((value) => value),
	afterContent: z
		.string()
		.optional()
		.transform((value) => value),
	snapshotId: z
		.string()
		.optional()
		.transform((value) => value),
	status: z.enum(['pending', 'approved', 'rejected']),
	hunkStatuses: z.array(z.enum(['pending', 'approved', 'rejected'])),
	sessionId: z.string(),
	sessionIds: z.array(z.string()).optional(),
	reviewId: z.string().optional(),
});

export const pendingChangesFileSchema = z.record(z.string(), pendingFileChangeSchema);

export const reviewHunkStatusSchema = z.enum(['pending', 'approved', 'rejected']);

export const reviewEntrySchema = z.object({
	id: z.string(),
	path: z.string(),
	action: z.enum(['create', 'edit', 'delete', 'move']),
	beforeContent: z.string().optional(),
	afterContent: z.string().optional(),
	snapshotId: z.string().optional(),
	status: z.literal('pending'),
	hunkStatuses: z.array(reviewHunkStatusSchema),
	latestSessionId: z.string(),
	sessionIds: z.array(z.string()),
	diffSignature: z.string(),
	updatedAt: z.number(),
});

export const reviewResolveSchema = z.object({
	decision: z.enum(['accept', 'reject']),
});

export const reviewResolveManySchema = z.object({
	decision: z.enum(['accept', 'reject']),
	sessionId: z.string().optional(),
	reviewIds: z.array(z.string()).optional(),
});

export const reviewHunkUpdateSchema = z.object({
	hunkStatuses: z.array(reviewHunkStatusSchema),
});

export const debugLogIdSchema = z
	.string()
	.min(1, 'Debug log ID is required')
	.max(64, 'Debug log ID must be at most 64 characters')
	.regex(/^[a-z0-9-]+$/, 'Debug log ID must contain only lowercase alphanumeric characters and hyphens');
export const snapshotIdSchema = z
	.string()
	.min(1, 'Snapshot ID is required')
	.max(LIMITS.SNAPSHOT_ID_MAX_LENGTH, `Snapshot ID must be at most ${LIMITS.SNAPSHOT_ID_MAX_LENGTH} characters`)
	.regex(/^[a-f0-9]+$/, 'Snapshot ID must be a valid hexadecimal string');
export const revertFileSchema = z.object({
	path: filePathSchema,
	snapshotId: snapshotIdSchema,
});

export type RevertFileInput = z.infer<typeof revertFileSchema>;

export const revertCascadeSchema = z.object({
	snapshotIds: z.array(snapshotIdSchema).min(1).max(20),
});

export type RevertCascadeInput = z.infer<typeof revertCascadeSchema>;

const NPM_PACKAGE_NAME_PATTERN = /^(?:@[\da-z~-][\d._a-z~-]*\/)?[\da-z~-][\d._a-z~-]*$/;

const DEPENDENCY_VERSION_PATTERN =
	/^(?:\*|latest|(?:[~^]|[<>]=?)?(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*|x))?(?:\.(?:0|[1-9]\d*|x))?(?:-[\d.a-z-]+)?(?:\+[\d.a-z-]+)?)$/;
export function validateDependencyName(name: string): string | undefined {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return 'Dependency name is required';
	}
	if (trimmed.length > 214) {
		return 'Dependency name must be at most 214 characters';
	}
	if (!NPM_PACKAGE_NAME_PATTERN.test(trimmed)) {
		return `Invalid package name`;
	}
	return undefined;
}
export function validateDependencyVersion(version: string): string | undefined {
	const trimmed = version.trim();
	if (trimmed.length === 0) {
		return 'Version is required';
	}
	if (!DEPENDENCY_VERSION_PATTERN.test(trimmed)) {
		return `Invalid version, use * for latest.`;
	}
	return undefined;
}
export const assetSettingsSchema = z.object({
	not_found_handling: z.enum(['none', 'single-page-application', '404-page']).optional(),
	html_handling: z.enum(['auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none']).optional(),
	run_worker_first: z.union([z.boolean(), z.array(z.string().regex(/^!?\//, 'Patterns must begin with / or !/'))]).optional(),
});

export type AssetSettingsInput = z.infer<typeof assetSettingsSchema>;
export const bindingsConfigSchema = z.object({
	storage: z.boolean().optional(),
});

export type BindingsConfigInput = z.infer<typeof bindingsConfigSchema>;

export const projectMetaSchema = z.object({
	name: z
		.string()
		.min(1, 'Name is required')
		.max(MAX_PROJECT_NAME_LENGTH, `Name must be at most ${MAX_PROJECT_NAME_LENGTH} characters`)
		.optional(),
	assetSettings: assetSettingsSchema.optional(),
	bindingsConfig: bindingsConfigSchema.optional(),
});

export const dependenciesUpdateSchema = z.object({
	dependencies: z.record(z.string(), z.string()),
});
export const testRunRequestSchema = z.object({
	pattern: z.string().max(500, 'Pattern must be at most 500 characters').optional(),
	testName: z.string().max(500, 'Test name must be at most 500 characters').optional(),
});

export type TestRunRequestInput = z.infer<typeof testRunRequestSchema>;
export const transformCodeSchema = z.object({
	code: z.string(),
	filename: z.string(),
});

export type TransformCodeInput = z.infer<typeof transformCodeSchema>;
export const pathQuerySchema = z.object({
	path: filePathSchema,
});
export const sessionIdQuerySchema = z.object({
	id: sessionIdSchema,
});
const safeGitPath = z
	.string()
	.min(1, 'Path is required')
	.refine((path) => !path.includes('..'), 'Path must not contain ".."')
	.refine((path) => !path.includes('\0'), 'Path must not contain null bytes');
export const gitStageSchema = z.object({
	paths: z.array(safeGitPath).min(1, 'At least one path is required'),
});

export type GitStageInput = z.infer<typeof gitStageSchema>;
export const gitDiscardSchema = z.object({
	path: safeGitPath,
});

export type GitDiscardInput = z.infer<typeof gitDiscardSchema>;
export const gitCommitSchema = z.object({
	message: z.string().min(1, 'Commit message is required').max(5000, 'Commit message is too long'),
	amend: z.boolean().optional(),
});

export type GitCommitInput = z.infer<typeof gitCommitSchema>;
export const gitBranchSchema = z.object({
	name: z
		.string()
		.min(1, 'Branch name is required')
		.max(255, 'Branch name is too long')
		.refine((name) => !name.includes(' '), 'Branch name cannot contain spaces')
		.refine((name) => !name.startsWith('-'), 'Branch name cannot start with a dash')
		.refine((name) => !name.includes('..'), 'Branch name cannot contain ".."')
		.refine((name) => !name.endsWith('.lock'), 'Branch name cannot end with ".lock"'),
	checkout: z.boolean().optional(),
});

export type GitBranchInput = z.infer<typeof gitBranchSchema>;
export const gitBranchRenameSchema = z.object({
	oldName: z.string().min(1, 'Old branch name is required').max(255, 'Branch name is too long'),
	newName: z.string().min(1, 'New branch name is required').max(255, 'Branch name is too long'),
});

export type GitBranchRenameInput = z.infer<typeof gitBranchRenameSchema>;
export const gitCheckoutSchema = z.object({
	reference: z.string().min(1, 'Reference is required').max(255, 'Reference is too long'),
});

export type GitCheckoutInput = z.infer<typeof gitCheckoutSchema>;
export const gitMergeSchema = z.object({
	branch: z.string().min(1, 'Branch name is required').max(255, 'Branch name is too long'),
});

export type GitMergeInput = z.infer<typeof gitMergeSchema>;
export const gitTagSchema = z.object({
	name: z.string().min(1, 'Tag name is required').max(255, 'Tag name is too long'),
	reference: z.string().optional(),
});

export type GitTagInput = z.infer<typeof gitTagSchema>;
export const gitStashSchema = z.object({
	action: z.enum(['push', 'pop', 'apply', 'drop', 'clear']),
	index: z.number().int().min(0).optional(),
	message: z.string().max(500).optional(),
});

export type GitStashInput = z.infer<typeof gitStashSchema>;
export const gitLogQuerySchema = z.object({
	reference: z.string().optional(),
	depth: z.coerce.number().int().min(1).max(500).optional(),
});

export type GitLogQuery = z.infer<typeof gitLogQuerySchema>;
export const gitGraphQuerySchema = z.object({
	maxCount: z.coerce.number().int().min(1).max(500).optional(),
});

export type GitGraphQuery = z.infer<typeof gitGraphQuerySchema>;
export const gitDiffQuerySchema = z.object({
	path: safeGitPath,
});

export type GitDiffQuery = z.infer<typeof gitDiffQuerySchema>;
export const gitCommitDiffQuerySchema = z.object({
	objectId: z.string().min(1, 'Object ID is required'),
});

export type GitCommitDiffQuery = z.infer<typeof gitCommitDiffQuerySchema>;
export const gitFileDiffAtCommitQuerySchema = z.object({
	objectId: z.string().min(1, 'Object ID is required'),
	path: safeGitPath,
});

export type GitFileDiffAtCommitQuery = z.infer<typeof gitFileDiffAtCommitQuerySchema>;
export const gitBranchNameQuerySchema = z.object({
	name: z.string().min(1, 'Branch name is required'),
});
export const gitTagNameQuerySchema = z.object({
	name: z.string().min(1, 'Tag name is required'),
});
export const gitCredentialRequestSchema = z.object({});

export type GitCredentialRequestInput = z.infer<typeof gitCredentialRequestSchema>;
export const savedCredentialsSchema = z.object({
	accountId: z.string(),
	apiToken: z.string(),
});

export type SavedCredentialsParsed = z.infer<typeof savedCredentialsSchema>;

const persistedStoreShape = {
	sidebarVisible: z.boolean(),
	utilityPanelVisible: z.boolean(),
	agentPanelVisible: z.boolean(),
	devtoolsVisible: z.boolean(),
	dependenciesPanelVisible: z.boolean(),
	colorScheme: z.enum(['light', 'dark', 'system']),
	editorFont: z.enum(EDITOR_FONT_SLUGS).optional().default(DEFAULT_EDITOR_FONT),
	activeMobilePanel: z.enum(['editor', 'preview', 'git', 'agent', 'tests']),
	activeSidebarView: z.enum(['explorer', 'git', 'tests']),
	expandedDirs: z.array(z.string()),
	selectedModel: aiModelSchema,
} as const;

export const persistedStoreSchema = z
	.object({
		...persistedStoreShape,
		agentPanelVisible: z.boolean().optional(),
		aiPanelVisible: z.boolean().optional(),
	})
	.transform(({ aiPanelVisible, agentPanelVisible, ...state }) => ({
		...state,
		agentPanelVisible: agentPanelVisible ?? aiPanelVisible ?? false,
	}));

export type PersistedStoreParsed = z.infer<typeof persistedStoreSchema>;
export const editorSessionSchema = z.object({
	openFiles: z.array(z.string()),
	activeFile: z.string().optional(),
	scrollPositions: z.record(z.string(), z.number()).default({}),
	cursorPositions: z.record(z.string(), z.object({ line: z.number(), column: z.number() })).default({}),
});

export type EditorSessionParsed = z.infer<typeof editorSessionSchema>;
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
export function isPathSafe(path: string): boolean {
	const result = filePathSchema.safeParse(path);
	return result.success;
}

export const pushSubscriptionBodySchema = z.object({
	endpoint: z.string().min(1),
	key: z.string().min(1),
	auth: z.string().min(1),
});

export const pushUnsubscribeBodySchema = z.object({
	endpoint: z.string().min(1),
});

export const pushNotificationPreferenceBodySchema = z.object({
	endpoint: z.string().min(1),
	enabled: z.boolean(),
});

export const favoriteBodySchema = z.object({
	favorite: z.boolean(),
});

export const visibilityBodySchema = z.object({
	visibility: z.enum(['public', 'private']),
});

export const transferInitiateBodySchema = z.object({
	targetOrganizationId: z.string().min(1),
});

export const deployRequestSchema = z.object({
	accountId: z.string().min(1, 'Account ID is required'),
	apiToken: z.string().min(1, 'API Token is required'),
	workerName: z.string().optional(),
});

export const userPreferencesBodySchema = z
	.record(z.string(), z.string())
	.transform((record) => {
		const filtered: Record<string, string> = {};
		for (const key of USER_PREFERENCE_KEYS) {
			if (key in record) {
				filtered[key] = record[key];
			}
		}
		return filtered;
	})
	.refine((record) => Object.keys(record).length > 0, {
		message: 'At least one valid preference key is required',
	});

export { DEFAULT_AI_MODEL } from './constants';
