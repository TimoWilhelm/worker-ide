/**
 * File system constants for the Worker IDE application.
 */

/**
 * Protected files that cannot be deleted
 */
export const PROTECTED_FILES = new Set([
	'/worker/index.ts',
	'/worker/index.js',
	'/tsconfig.json',
	'/tsconfig.app.json',
	'/tsconfig.worker.json',
	'/package.json',
	'/wrangler.jsonc',
	'/vite.config.ts',
	'/vitest.config.ts',
	'/index.html',
]);

/**
 * Protected system files managed by the IDE.
 * Regenerated when project settings change (name, dependencies, asset config).
 * Users cannot edit them directly — the IDE provides dedicated UI instead.
 */
export const PROTECTED_SYSTEM_FILES = new Set(['/package.json', '/wrangler.jsonc', '/vite.config.ts', '/vitest.config.ts']);

/**
 * Check if a file path is a protected system file managed by the IDE.
 */
export function isProtectedSystemFile(path: string): boolean {
	return PROTECTED_SYSTEM_FILES.has(path);
}

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

/**
 * Hidden entries (directories and files) that should be excluded from file listings
 */
export const HIDDEN_ENTRIES = new Set(['.initialized', '.agent', '.git']);
