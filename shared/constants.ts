/**
 * Shared constants for the Worker IDE application.
 */

// =============================================================================
// File System Constants
// =============================================================================

/**
 * Protected files that cannot be deleted
 */
export const PROTECTED_FILES = new Set(['/worker/index.ts', '/worker/index.js', '/tsconfig.json', '/package.json', '/index.html']);

/**
 * Binary file extensions for snapshot handling
 */
export const BINARY_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
	'.svg',
	'.woff',
	'.woff2',
	'.ttf',
	'.eot',
	'.otf',
	'.pdf',
	'.zip',
	'.tar',
	'.gz',
	'.mp3',
	'.mp4',
	'.webm',
	'.ogg',
	'.wav',
	'.bin',
	'.exe',
	'.dll',
]);

/**
 * Extensions that should be compiled to JavaScript
 */
export const COMPILE_TO_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.jsx', '.mts']);

/**
 * Extensions that should be transformed to JS modules (CSS, JSON, assets)
 */
export const TRANSFORM_TO_JS_MODULE_EXTENSIONS = new Set([
	'.css',
	'.json',
	'.svg',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
	'.woff',
	'.woff2',
	'.ttf',
	'.txt',
	'.md',
]);

// =============================================================================
// MIME Type Mappings
// =============================================================================

/**
 * File extension to content type mapping
 */
export const CONTENT_TYPE_MAP: Record<string, string> = {
	html: 'text/html',
	js: 'application/javascript',
	mjs: 'application/javascript',
	css: 'text/css',
	json: 'application/json',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	eot: 'application/vnd.ms-fontobject',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	mp4: 'video/mp4',
	webm: 'video/webm',
	txt: 'text/plain',
	md: 'text/markdown',
};

// =============================================================================
// Collaboration Constants
// =============================================================================

/**
 * Colors for collaboration cursors
 */
export const COLLAB_COLORS = [
	'#f97316', // orange
	'#22d3ee', // cyan
	'#a78bfa', // purple
	'#f472b6', // pink
	'#4ade80', // green
	'#facc15', // yellow
	'#fb923c', // orange-400
	'#38bdf8', // sky
	'#c084fc', // violet
	'#34d399', // emerald
	'#e879f9', // fuchsia
] as const;

// =============================================================================
// Agent Internal Constants
// =============================================================================

/**
 * Maximum characters to read from an AGENTS.md file for context injection
 */
export const AGENTS_MD_MAX_CHARACTERS = 16_000;

/**
 * Hardcoded MCP server configurations.
 * Users cannot add their own servers.
 */
export const MCP_SERVERS = [
	{
		id: 'cloudflare-docs',
		name: 'Cloudflare Documentation',
		endpoint: 'https://docs.mcp.cloudflare.com/mcp',
	},
] as const;

// =============================================================================
// AI Agent Constants
// =============================================================================

/**
 * System prompt for the AI coding assistant.
 *
 * Modeled on OpenCode's anthropic.txt — structured by concern (tone, tool usage, project info).
 * With TanStack AI, tool descriptions are provided via the tool definitions —
 * they do NOT need to be repeated here.
 *
 * NOTE: This prompt is provider-neutral. Provider-specific guidance (e.g., text-completion
 * tool efficiency hints for Replicate) is injected by the adapter in replicate/adapter.ts.
 */
export const AGENT_SYSTEM_PROMPT = `You are an AI coding assistant integrated into a web-based IDE. Your role is to help users with software engineering tasks including solving bugs, adding new functionality, refactoring code, and explaining code.

# Tone and style
- Be concise but helpful. Focus on making the requested changes efficiently.
- Do NOT start responses with filler like "Sure!", "Great question!", or "I'd be happy to help!". Get straight to the point.
- Explain what you're doing and why before making changes.
- Prioritize technical accuracy and correctness over agreeing with the user. If the user's approach has issues, say so directly and suggest a better alternative. Respectful correction is more valuable than false agreement.

# Final summary
When you have finished all changes, you MUST end with a concise summary of what was done. This summary should:
- List the files that were created, modified, or deleted.
- Briefly describe each change in one line (e.g., "Added error handling to fetchData in api.ts").
- Mention any follow-up actions the user should take (e.g., "You may want to test the form with edge cases" or "Run npm test to verify").
- Do NOT repeat the full code or lengthy explanations — keep it short and scannable.
- If no files were changed (e.g., you only answered a question or read code), skip the file list and just summarize your findings concisely.

# Tool usage policy

## CRITICAL: Explore before coding
You know NOTHING about this project until you look. Before making ANY code changes, you MUST:
1. Use \`files_list\` to see the project's file structure.
2. Use \`file_read\` to read the ACTUAL contents of every file you plan to modify.
3. Use \`file_grep\` to find the exact code patterns you need to change.

NEVER assume what a file contains — variable names, function signatures, JSX structure, class names, CSS selectors, and HTML content are all UNKNOWN until you read them. If you guess wrong, your edits will fail.

Your first response should be an exploration step: discover the project structure and read the relevant files. Only start editing once you have seen the real code.

## CRITICAL: One tool call per response
- You MUST call exactly ONE tool per response. Never call multiple tools in a single response.
- After each tool result, reflect on the outcome and decide your next step before calling the next tool.
- This applies to ALL tools — both read-only and mutation tools.

## Think before you act
- Before each tool call, briefly explain your reasoning and what you expect to find or change.
- After receiving a tool result, reflect on the outcome before deciding your next step.

## Read before you edit
- You MUST read a file with \`file_read\` before editing it with \`file_edit\` or \`file_write\`.
- Never assume file contents — always verify by reading first.
- Use \`file_grep\` and \`file_glob\` to discover relevant files before making changes.
- Use \`file_read\` with offset/limit for large files instead of reading the entire file.

## Mutations
- After a file_edit or file_write succeeds, the file content has changed. If you need to make another edit to the same file, re-read it first to get the updated content.

## Follow existing conventions
- When modifying files, preserve existing code style and patterns. Before writing new code, look at the surrounding context and nearby files to match conventions (naming, formatting, structure).
- When creating a new component or module, first look at existing ones to mimic the established patterns.
- NEVER assume a library or utility is available. Use \`file_grep\` or \`dependencies_list\` to verify it exists in the project before importing it.
- Do NOT add code comments unless the user explicitly asks for them. The code should be self-explanatory.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.

## When to ask vs. proceed
- Use \`user_question\` when the user's intent is ambiguous, when there are multiple valid approaches with meaningful trade-offs, or when an action could have unintended side effects.
- If the user asks how to approach something, answer their question first — do not immediately jump into making changes.
- Do not surprise the user with large-scale changes they did not request. Stay focused on what was asked.

# Dependencies
Dependencies (npm packages) are managed at the project level, NOT via package.json.
- package.json is auto-generated on download and CANNOT be created manually.
- Before importing a new package, you MUST register it using the \`dependencies_update\` tool.
- Use \`dependencies_list\` to check which packages are already registered.
- NEVER assume a package is installed. Always verify with \`dependencies_list\` before using a new import.

# Security
- Follow security best practices. Never introduce code that exposes or logs secrets, API keys, or credentials.
- Refuse to create, modify, or improve code that is clearly intended to be used maliciously (e.g., malware, phishing, credential harvesting).
- Defensive security tasks (vulnerability analysis, detection rules, security documentation) are fine.`;

/**
 * Additional system prompt appended when Plan mode is active
 */
export const PLAN_MODE_SYSTEM_PROMPT = `

You are currently in PLAN MODE. In this mode:
- You CANNOT create, edit, delete, or move files. Mutation tools are not available.
- You CAN use read-only tools (\`file_read\`, \`file_grep\`, \`file_glob\`, \`file_list\`, \`files_list\`, \`docs_search\`, \`cdp_eval\`, \`todos_get\`, \`dependencies_list\`) and research tools (\`web_fetch\`, \`user_question\`).
- You CAN manage TODOs with \`todos_update\` and save your plan with \`plan_update\`.
- Your goal is to thoroughly research the codebase and produce a detailed implementation plan.
- Read all relevant files to understand the existing code structure, patterns, and dependencies.
- Use \`file_grep\` and \`file_glob\` liberally to discover related code before forming your plan.
- You MUST save your plan using the \`plan_update\` tool. Do NOT output the plan as a final markdown response — always persist it via the tool.
- The plan saved with \`plan_update\` should be a well-structured markdown document that includes:
  1. A summary of the current state of the code
  2. Step-by-step implementation instructions
  3. Files to create or modify (with specific details)
  4. Potential risks or considerations
  5. Testing recommendations
- Be thorough and specific. The plan should be actionable by a developer or AI agent.
- After saving the plan, ask the user if they would like to proceed with implementation (by switching to Code mode).`;

/**
 * Additional system prompt appended when Ask mode is active
 */
export const ASK_MODE_SYSTEM_PROMPT = `

You are currently in ASK MODE. In this mode:
- You have NO tools available. You cannot read, write, or search files.
- Your role is to answer questions, explain concepts, and have a conversation.
- Draw on your training knowledge to help the user.
- If the user asks you to make code changes, suggest they switch to Code mode.
- Be concise, helpful, and conversational.`;

// =============================================================================
// Project Constants
// =============================================================================

/**
 * Default project expiration time in days
 */
export const PROJECT_EXPIRATION_DAYS = 365;

/**
 * Hidden entries (directories and files) that should be excluded from file listings
 */
export const HIDDEN_ENTRIES = new Set(['.initialized', '.project-meta.json', '.agent', '.git']);

// =============================================================================
// AI Model Configuration
// =============================================================================

/**
 * Configuration for an AI model.
 * This is the single source of truth for available models.
 * Both server-side validation and UI components use this configuration.
 *
 * To add a new model:
 * 1. Add a new entry to this array with id, label, and optional description
 * 2. That's it! The model will be available in the UI and validated on the server
 */
export interface AIModelConfig<TId extends string = string> {
	/** Unique identifier for the model (e.g., "anthropic/claude-4.5-haiku") */
	id: TId;
	/** Display label shown in the UI (e.g., "Haiku 4.5") */
	label: string;
	/** Optional description of the model's capabilities */
	description?: string;
}

/**
 * Available AI models configuration.
 * Add new models here to make them available throughout the application.
 *
 * IMPORTANT: Model IDs must follow the format "provider/model-name" (e.g., "anthropic/claude-4.5-haiku")
 */
export const AI_MODELS = [
	{
		id: 'anthropic/claude-4.5-haiku',
		label: 'Claude Haiku 4.5',
		description: 'Fast and efficient for everyday tasks',
	},
	// Add more models here as they become available:
	// {
	// 	id: 'anthropic/claude-4-sonnet',
	// 	label: 'Sonnet 4',
	// 	description: 'Balanced performance and capability',
	// },
] as const satisfies readonly AIModelConfig<`${string}/${string}`>[];

/**
 * Type for AI model IDs (Replicate format: "provider/model-name")
 */
export type AIModelId = (typeof AI_MODELS)[number]['id'];

/**
 * Array of model IDs for iteration
 */
export const AI_MODEL_IDS: readonly AIModelId[] = AI_MODELS.map((model) => model.id);

/**
 * Tuple of model IDs for Zod enum validation.
 * This is defined separately because z.enum() requires a tuple type [string, ...string[]].
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Required for Zod enum tuple type
export const AI_MODEL_IDS_TUPLE = AI_MODEL_IDS as readonly [AIModelId, ...AIModelId[]];

/**
 * Default AI model ID
 */
export const DEFAULT_AI_MODEL: AIModelId = AI_MODELS[0].id;

/**
 * Model used for internal summarization tasks (e.g., web_fetch content summarization).
 */
export const SUMMARIZATION_AI_MODEL: AIModelId = 'anthropic/claude-4.5-haiku';

/**
 * Get the display label for a model ID.
 * Returns the ID itself if no matching model is found.
 */
export function getModelLabel(modelId: string): string {
	const model = AI_MODELS.find((m) => m.id === modelId);
	return model?.label ?? modelId;
}

/**
 * Get the full configuration for a model ID.
 * Returns undefined if no matching model is found.
 */
export function getModelConfig(modelId: string): AIModelConfig | undefined {
	return AI_MODELS.find((m) => m.id === modelId);
}

// =============================================================================
// API Constants
// =============================================================================

/**
 * Default headers for JSON API responses
 */
export const JSON_HEADERS = {
	'Content-Type': 'application/json',
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
} as const;
