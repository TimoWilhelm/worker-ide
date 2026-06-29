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
import { VendoredLayer } from '../node-fs/memory-file-system';

import type { MemoryFileSystem } from '../node-fs/memory-file-system';

const files: Record<string, string> = nodeModuleFiles;

/**
 * The vendored `node_modules` as a single shared, read-only layer, built once
 * per isolate. Every build's filesystem references it (no per-build copy), so
 * the ~11 MB of package source is resident a single time.
 */
let layer: VendoredLayer | undefined;

/** Expose the vendored `node_modules` package source to `fileSystem`. */
export function seedNodeModules(fileSystem: MemoryFileSystem): void {
	layer ??= VendoredLayer.fromRecord(files, '/');
	fileSystem.addBaseLayer(layer);
}
