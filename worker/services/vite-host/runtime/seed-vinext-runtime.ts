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
import { VINEXT_RUNTIME_DIST_ROOT, VINEXT_RUNTIME_ROOT } from './vinext-runtime-paths';
import vinextRuntimeFiles from '../../../../auxiliary/vite-host/vendor/vinext-runtime.js';
import { VendoredLayer } from '../node-fs/memory-file-system';

import type { MemoryFileSystem } from '../node-fs/memory-file-system';

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
	const mirrored: Record<string, string> = {};
	for (const [relativePath, contents] of Object.entries(runtimeFiles)) {
		mirrored[`${VINEXT_RUNTIME_DIST_ROOT}/${relativePath}`] = contents;
		mirrored[`${VINEXT_RUNTIME_ROOT}/${relativePath}`] = contents;
	}
	// vinext resolves its instrumentation empty-module relative to the pinned
	// runtime dirname (`/__vinext__/dist`), but the real file lives in
	// `dist/client`. Provide an empty module at the resolved root so the `.js`
	// existence check succeeds.
	for (const root of [VINEXT_RUNTIME_DIST_ROOT, VINEXT_RUNTIME_ROOT]) {
		mirrored[`${root}/empty-module.js`] = 'export {};\n';
	}
	return VendoredLayer.fromRecord(mirrored);
}

/** Expose the embedded vinext runtime to `fileSystem` at the expected roots. */
export function seedVinextRuntime(fileSystem: MemoryFileSystem): void {
	layer ??= buildRuntimeLayer();
	fileSystem.addBaseLayer(layer);
}
