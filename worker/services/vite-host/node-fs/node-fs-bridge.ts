/**
 * Per-isolate handle to the project filesystem backing the `node:fs` facade.
 *
 * Like the `vite` shim's service bridge, the `node:fs`/`node:fs/promises`
 * facades are aliased *into* the plugin bundle and run in their own module
 * realm. The host hydrates a {@link MemoryFileSystem} from the project tree and
 * publishes it here before evaluating plugin code; the facades read it back.
 */
import type { MemoryFileSystem } from './memory-file-system';

declare global {
	var __VITE_HOST_PROJECT_FS__: MemoryFileSystem | undefined;
}

/** Publish the project filesystem for the `node:fs` facades to use. */
export function installProjectFileSystem(fileSystem: MemoryFileSystem): void {
	globalThis.__VITE_HOST_PROJECT_FS__ = fileSystem;
}

/** Read the published project filesystem, throwing if the host has not set it. */
export function getProjectFileSystem(): MemoryFileSystem {
	const fileSystem = globalThis.__VITE_HOST_PROJECT_FS__;
	if (fileSystem === undefined) {
		throw new Error('node:fs facade used before the project filesystem was installed');
	}
	return fileSystem;
}
