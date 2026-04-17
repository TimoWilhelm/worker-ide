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
	'/worker-env.d.ts',
	'/index.html',
]);

/**
 * Protected system files managed by the IDE.
 * Regenerated when project settings change (name, dependencies, asset config, bindings).
 * Users cannot edit them directly — the IDE provides dedicated UI instead.
 */
const PROTECTED_SYSTEM_FILE_PATHS = [
	'/package.json',
	'/wrangler.jsonc',
	'/vite.config.ts',
	'/vitest.config.ts',
	'/worker-env.d.ts',
] as const;

export type ProtectedSystemFile = (typeof PROTECTED_SYSTEM_FILE_PATHS)[number];

export const PROTECTED_SYSTEM_FILES: ReadonlySet<string> = new Set<string>(PROTECTED_SYSTEM_FILE_PATHS);
export function isProtectedSystemFile(path: string): boolean {
	return PROTECTED_SYSTEM_FILES.has(path);
}
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
export const COMPILE_TO_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.jsx', '.mts']);
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
export const HIDDEN_ENTRIES = new Set(['.initialized', '.agent', '.git']);
