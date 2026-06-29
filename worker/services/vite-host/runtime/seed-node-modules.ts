/**
 * Seed the vendored React + RSC package source into the in-memory project
 * filesystem at `/node_modules/<pkg>/...`.
 *
 * The esbuild bridge resolves these via `package-resolver` with per-environment
 * export conditions (`react-server` for RSC) and bundles the real source, so
 * esbuild handles CommonJS↔ESM interop natively and each environment inlines a
 * single, correctly-conditioned React instance.
 */
import nodeModuleFiles from '../../../../auxiliary/vite-host/vendor/node-modules.js';

import type { MemoryFileSystem } from '../node-fs/memory-file-system';

const files: Record<string, string> = nodeModuleFiles;

/** Write the vendored `node_modules` package source into `fileSystem`. */
export function seedNodeModules(fileSystem: MemoryFileSystem): void {
	for (const [relativePath, contents] of Object.entries(files)) {
		fileSystem.writeFile(`/${relativePath}`, contents);
	}
}
