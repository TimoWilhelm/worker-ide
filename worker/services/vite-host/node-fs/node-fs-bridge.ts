/**
 * Per-isolate handle to the project filesystem backing the `node:fs` facade.
 *
 * Like the `vite` shim's service bridge, the `node:fs`/`node:fs/promises`
 * facades are aliased *into* the plugin bundle and run in their own module
 * realm. The host hydrates a {@link MemoryFileSystem} from the project tree and
 * publishes it here before evaluating plugin code; the facades read it back.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { MemoryFileSystem } from './memory-file-system';

const projectFileSystemStorage = new AsyncLocalStorage<MemoryFileSystem>();

/** Scope the project filesystem to one build's async call chain. */
export function runWithProjectFileSystem<T>(fileSystem: MemoryFileSystem, callback: () => T): T {
	return projectFileSystemStorage.run(fileSystem, callback);
}

/** Read the published project filesystem, throwing if the host has not set it. */
export function getProjectFileSystem(): MemoryFileSystem {
	const fileSystem = projectFileSystemStorage.getStore();
	if (fileSystem === undefined) {
		throw new Error('node:fs facade used before the project filesystem was installed');
	}
	return fileSystem;
}
