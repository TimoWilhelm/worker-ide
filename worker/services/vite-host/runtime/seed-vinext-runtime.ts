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
const APP_BROWSER_ENTRY = 'server/app-browser-entry.js';

const HMR_HANDLER_BEFORE = `const handleRscUpdate = async (updateId) => {
\t\t\ttry {
\t\t\t\tawait waitForRscHmrSettle();
\t\t\t\tawait applyRscHmrUpdate(updateId);
\t\t\t} catch (error) {
\t\t\t\tconsole.error("[vinext] RSC HMR error:", error);
\t\t\t}
\t\t};`;

const HMR_HANDLER_AFTER = `const handleRscUpdate = async (updateId, attempt = 0) => {
\t\t\ttry {
\t\t\t\tawait waitForRscHmrSettle();
\t\t\t\tawait applyRscHmrUpdate(updateId);
\t\t\t} catch (error) {
\t\t\t\tif (updateId !== latestRscHmrUpdateId) return;
\t\t\t\tif (attempt < 2) {
\t\t\t\t\twindow.setTimeout(() => handleRscUpdate(updateId, attempt + 1), 500);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tconsole.error("[vinext] RSC HMR error:", error);
\t\t\t}
\t\t};`;

/** Recover from transient RSC stream closures while rapid edits supersede an HMR request. */
export function patchVinextRscHmrRecovery(source: string): string {
	if (!source.includes(HMR_HANDLER_BEFORE)) {
		throw new Error('Could not patch vinext RSC HMR recovery: handler source changed.');
	}
	return source.replace(HMR_HANDLER_BEFORE, HMR_HANDLER_AFTER);
}

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
		const runtimeSource =
			relativePath === APP_BROWSER_ENTRY ? compressVendoredFile(patchVinextRscHmrRecovery(decompressVendoredFile(compressed))) : compressed;
		mirrored[`${VINEXT_RUNTIME_DIST_ROOT}/${relativePath}`] = runtimeSource;
		mirrored[`${VINEXT_RUNTIME_ROOT}/${relativePath}`] = runtimeSource;
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
