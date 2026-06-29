/**
 * Seed the vendored React + RSC package source into the in-memory project
 * filesystem at `/node_modules/<pkg>/...`.
 *
 * The esbuild bridge resolves these via `package-resolver` with per-environment
 * export conditions (`react-server` for RSC) and bundles the real source, so
 * esbuild handles CommonJS↔ESM interop natively and each environment inlines a
 * single, correctly-conditioned React instance.
 *
 * The source is split into two layers. The base layer (production + shared
 * source) is always seeded. The development layer (`*.development.js`) is seeded
 * only for the preview build, whose client is built with `NODE_ENV=development`
 * so React DOM ships its Fast Refresh helpers. A production deploy build runs
 * `NODE_ENV=production`, dead-code-eliminates the `require('./*.development.js')`
 * branch, and never reads those files — so skipping them keeps ~7 MB of unused
 * source out of the deploy isolate's 128 MB budget.
 */
import { decompressVendoredFile } from './vendored-decompress';
import nodeModuleDevelopmentFiles from '../../../../auxiliary/vite-host/vendor/node-modules-development.js';
import nodeModuleFiles from '../../../../auxiliary/vite-host/vendor/node-modules.js';
import { VendoredLayer } from '../node-fs/memory-file-system';

import type { MemoryFileSystem } from '../node-fs/memory-file-system';

const baseFiles: Record<string, string> = nodeModuleFiles;
const developmentFiles: Record<string, string> = nodeModuleDevelopmentFiles;

/**
 * The vendored `node_modules` as shared, read-only layers, built once per
 * isolate. Every build's filesystem references them (no per-build copy), so the
 * package source is resident a single time. The development layer is created
 * lazily — a deploy-only isolate never instantiates it.
 */
let baseLayer: VendoredLayer | undefined;
let developmentLayer: VendoredLayer | undefined;

/**
 * Expose the vendored `node_modules` package source to `fileSystem`.
 *
 * @param options.includeDevelopment Seed the `*.development.js` React/RSC builds
 *   too (required by the preview client's Fast Refresh; omitted for deploy).
 */
export function seedNodeModules(fileSystem: MemoryFileSystem, options: { includeDevelopment: boolean }): void {
	baseLayer ??= VendoredLayer.fromCompressedRecord(baseFiles, decompressVendoredFile, '/');
	fileSystem.addBaseLayer(baseLayer);
	if (options.includeDevelopment) {
		developmentLayer ??= VendoredLayer.fromCompressedRecord(developmentFiles, decompressVendoredFile, '/');
		fileSystem.addBaseLayer(developmentLayer);
	}
}
