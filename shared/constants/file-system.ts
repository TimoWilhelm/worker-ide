/**
 * File system constants for the Worker IDE application.
 */

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

/**
 * Hidden entries (directories and files) that should be excluded from file listings
 */
export const HIDDEN_ENTRIES = new Set(['.initialized', '.project-meta.json', '.agent', '.git']);
