/**
 * Seed vinext's `dist` runtime into the in-memory project filesystem.
 *
 * The generated RSC/SSR/client entries import vinext's runtime modules by
 * absolute path, derived from the pinned `import.meta.dirname`
 * (`/__vinext__/dist`). vinext computes some of those paths relative to that
 * dirname (`/__vinext__/dist/...`) and others one level up (`/__vinext__/...`),
 * so we mirror the embedded runtime at both roots. esbuild then bundles the
 * referenced modules into each environment's output.
 */
import { compressVendoredFile, decompressVendoredFile } from './vendored-decompress';
import { VINEXT_RUNTIME_DIST_ROOT, VINEXT_RUNTIME_ROOT } from './vinext-runtime-paths';
import vinextRuntimeFiles from '../../../../auxiliary/vite-host/vendor/vinext-runtime.js';
import { VendoredLayer } from '../node-fs/memory-file-system';

import type { MemoryFileSystem } from '../node-fs/memory-file-system';

/** Vendored runtime files, stored as `base64(gzip(source))` (decompressed lazily). */
const runtimeFiles: Record<string, string> = vinextRuntimeFiles;

/**
 * The embedded vinext runtime as a single shared, read-only layer, built once
 * per isolate. The runtime is mirrored at both roots vinext resolves against
 * (`/__vinext__/dist` and one level up); because the layer is referenced (not
 * copied), mirroring it costs only map entries, not a second ~3.5 MB byte copy.
 */
let layer: VendoredLayer | undefined;

/** Build the read-through runtime layer mirrored at both expected roots. */
function buildRuntimeLayer(): VendoredLayer {
	// Values stay in the vendored compressed form (decompressed lazily on read);
	// mirroring at both roots shares the same compressed string by reference.
	const mirrored: Record<string, string> = {};
	for (const [relativePath, compressed] of Object.entries(runtimeFiles)) {
		mirrored[`${VINEXT_RUNTIME_DIST_ROOT}/${relativePath}`] = compressed;
		mirrored[`${VINEXT_RUNTIME_ROOT}/${relativePath}`] = compressed;
	}
	// vinext resolves its instrumentation empty-module relative to the pinned
	// runtime dirname (`/__vinext__/dist`), but the real file lives in
	// `dist/client`. Provide an empty module (in the same compressed form) at the
	// resolved root so the `.js` existence check succeeds.
	const emptyModule = compressVendoredFile('export {};\n');
	for (const root of [VINEXT_RUNTIME_DIST_ROOT, VINEXT_RUNTIME_ROOT]) {
		mirrored[`${root}/empty-module.js`] = emptyModule;
	}
	return VendoredLayer.fromCompressedRecord(mirrored, decompressVendoredFile);
}

/** Expose the embedded vinext runtime to `fileSystem` at the expected roots. */
export function seedVinextRuntime(fileSystem: MemoryFileSystem): void {
	layer ??= buildRuntimeLayer();
	fileSystem.addBaseLayer(layer);
}
