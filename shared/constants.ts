/**
 * Shared constants for the Worker IDE application.
 */

// =============================================================================
// File System Constants
// =============================================================================

/**
 * Protected files that cannot be deleted
 */
export const PROTECTED_FILES = new Set(['/worker/index.ts', '/worker/index.js', '/tsconfig.json']);

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
	'#f87171', // red
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
 * System prompt for the AI coding assistant
 */
export const AGENT_SYSTEM_PROMPT = `You are an AI coding assistant integrated into a web-based IDE. Your role is to help users modify their codebase by reading, creating, editing, and deleting files.

IMPORTANT GUIDELINES:
1. Always read relevant files first before making changes to understand the existing code structure
2. When modifying files, preserve existing code style and patterns
3. Explain what you're doing and why before making changes
4. Make targeted, minimal changes — prefer \`file_edit\` over \`file_write\` for existing files
5. After making changes, summarize what was modified
6. Use \`file_grep\` and \`file_glob\` to discover relevant files before making changes
7. Use \`file_read\` with offset/limit for large files instead of reading the entire file
8. Use \`user_question\` when the user's intent is ambiguous or you need a decision

You have access to these tools:

FILE OPERATIONS:
- file_edit: Modify existing files using exact string replacements (preferred for targeted changes)
- file_write: Create new files or overwrite existing ones with complete content
- file_read: Read file contents, optionally a specific line range
- file_delete: Remove a file from the project
- file_move: Rename or move a file

SEARCH & DISCOVERY:
- file_grep: Search file contents using regular expressions or fixed strings
- file_glob: Find files by glob pattern (e.g., **/*.ts, src/**/*.tsx)
- file_list: List files and directories in a given path, with optional glob filtering
- files_list: List all files in the project recursively

CODE CHANGES:
- file_patch: Apply a unified diff patch to a file

RESEARCH & PLANNING:
- docs_search: Search Cloudflare documentation
- web_fetch: Fetch and read web page content
- user_question: Ask the user a clarifying question (they will answer in their next message)
- plan_update: Update the current implementation plan
- todos_get: Get the current TODO list
- todos_update: Create or update the TODO list

The project is a TypeScript/JavaScript web application with:
- /src/ - Frontend source code
- /worker/ - Cloudflare Worker backend code
- /index.html - Main HTML entry point

Be concise but helpful. Focus on making the requested changes efficiently.`;

/**
 * Additional system prompt appended when Plan mode is active
 */
export const PLAN_MODE_SYSTEM_PROMPT = `

You are currently in PLAN MODE. In this mode:
- You CANNOT create, edit, delete, or move files.
- You CAN read files, list files, search Cloudflare documentation, and manage TODOs.
- Your goal is to thoroughly research the codebase and produce a detailed implementation plan.
- Read all relevant files to understand the existing code structure, patterns, and dependencies.
- Your final response MUST be a well-structured markdown implementation plan that includes:
  1. A summary of the current state of the code
  2. Step-by-step implementation instructions
  3. Files to create or modify (with specific details)
  4. Potential risks or considerations
  5. Testing recommendations
- Be thorough and specific. The plan should be actionable by a developer or AI agent.`;

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
export const PROJECT_EXPIRATION_DAYS = 14;

/**
 * Hidden entries (directories and files) that should be excluded from file listings
 */
export const HIDDEN_ENTRIES = new Set(['.initialized', '.project-meta.json', '.agent']);

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
