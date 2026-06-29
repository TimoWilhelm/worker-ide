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

import type { MemoryFileSystem } from '../node-fs/memory-file-system';

const runtimeFiles: Record<string, string> = vinextRuntimeFiles;

let cachedEntries: Array<[string, string]> | undefined;

function runtimeEntries(): Array<[string, string]> {
	cachedEntries ??= Object.entries(runtimeFiles);
	return cachedEntries;
}

/** Write the embedded vinext runtime into `fileSystem` at the expected roots. */
export function seedVinextRuntime(fileSystem: MemoryFileSystem): void {
	for (const [relativePath, contents] of runtimeEntries()) {
		fileSystem.writeFile(`${VINEXT_RUNTIME_DIST_ROOT}/${relativePath}`, contents);
		fileSystem.writeFile(`${VINEXT_RUNTIME_ROOT}/${relativePath}`, contents);
	}
	// vinext resolves its instrumentation empty-module relative to the pinned
	// runtime dirname (`/__vinext__/dist`), but the real file lives in
	// `dist/client`. Seed an empty module at the resolved root so the `.js`
	// existence check succeeds.
	for (const root of [VINEXT_RUNTIME_DIST_ROOT, VINEXT_RUNTIME_ROOT]) {
		fileSystem.writeFile(`${root}/empty-module.js`, 'export {};\n');
	}
}
