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
4. Make targeted, minimal changes - don't rewrite entire files unless necessary
5. After making changes, summarize what was modified

You have access to a virtual filesystem with the following tools:
- list_files: See all files in the project
- read_file: Read a file's contents
- write_file: Create or update a file
- delete_file: Remove a file
- move_file: Rename or move a file

The project is a TypeScript/JavaScript web application with:
- /src/ - Frontend source code
- /worker/ - Cloudflare Worker backend code
- /index.html - Main HTML entry point

Be concise but helpful. Focus on making the requested changes efficiently.`;

/**
 * Tool definitions for the AI agent
 */
export const AGENT_TOOLS = [
	{
		name: 'list_files',
		description: 'List all files in the project. Returns an array of file paths.',
		input_schema: {
			type: 'object',
			properties: {},
		},
	},
	{
		name: 'read_file',
		description: 'Read the contents of a file. Use this to understand existing code before making changes.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path starting with /, e.g., /src/main.ts' },
			},
			required: ['path'],
		},
	},
	{
		name: 'write_file',
		description: 'Create a new file or overwrite an existing file with new content.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path starting with /, e.g., /src/utils.ts' },
				content: { type: 'string', description: 'The complete file content to write' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'delete_file',
		description: 'Delete a file from the project.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path to delete, starting with /' },
			},
			required: ['path'],
		},
	},
	{
		name: 'move_file',
		description: 'Move or rename a file.',
		input_schema: {
			type: 'object',
			properties: {
				from_path: { type: 'string', description: 'Current file path' },
				to_path: { type: 'string', description: 'New file path' },
			},
			required: ['from_path', 'to_path'],
		},
	},
] as const;

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
export const HIDDEN_ENTRIES = new Set(['.ai-sessions', '.snapshots', '.initialized', '.project-meta.json']);

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
