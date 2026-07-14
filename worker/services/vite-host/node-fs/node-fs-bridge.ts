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
const PROJECT_FILE_SYSTEM_KEY = '__viteHostProjectFileSystem';

/** Scope the project filesystem to one build's async call chain. */
export function runWithProjectFileSystem<T>(fileSystem: MemoryFileSystem, callback: () => T): T {
	// esbuild invokes plugin callbacks outside the originating async context in
	// workerd. The generated native-plugin bundle reads this shared fallback.
	Reflect.set(globalThis, PROJECT_FILE_SYSTEM_KEY, fileSystem);
	return projectFileSystemStorage.run(fileSystem, callback);
}

/** Read the published project filesystem, throwing if the host has not set it. */
export function getProjectFileSystem(): MemoryFileSystem {
	const fileSystem: MemoryFileSystem | undefined = projectFileSystemStorage.getStore() ?? Reflect.get(globalThis, PROJECT_FILE_SYSTEM_KEY);
	if (fileSystem === undefined) {
		throw new Error('node:fs facade used before the project filesystem was installed');
	}
	return fileSystem;
}
