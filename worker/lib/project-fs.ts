import { AsyncLocalStorage } from 'node:async_hooks';

import { createProjectFileSystem, PROJECT_ROOT } from './workspace-client';

import type { WorkspaceFsAdapter } from './workspace-fs-adapter';
import type { ProjectFilesystem } from '../durable/project-filesystem';

type Stub = DurableObjectStub<ProjectFilesystem>;

const storage = new AsyncLocalStorage<WorkspaceFsAdapter>();

/**
 * Run `fn` with a project filesystem bound for the duration of the async
 * context. Inside, the exported {@link fs} proxy resolves to this filesystem.
 *
 * This replaces `worker-fs-mount`'s request-scoped mount. There is a single
 * durable `Workspace` per project; this binds a `node:fs/promises`-compatible
 * view of it (over RPC) to the current async context.
 */
export function runWithProjectFs<R>(adapter: WorkspaceFsAdapter, function_: () => R): R {
	return storage.run(adapter, function_);
}

/** Bind a project filesystem for a DO stub and run `fn` within that context. */
export function runWithProjectStub<R>(stub: Stub, function_: () => R, prefix: string = PROJECT_ROOT): R {
	return storage.run(createProjectFileSystem(stub, prefix), function_);
}

function requireFs(): WorkspaceFsAdapter {
	const adapter = storage.getStore();
	if (!adapter) {
		throw new Error('No project filesystem bound for the current context. Wrap the call in runWithProjectFs().');
	}
	return adapter;
}

/**
 * A `node:fs/promises`-compatible proxy that forwards to the project filesystem
 * bound to the current async context. Import this in place of
 * `import fs from 'node:fs/promises'`.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- The empty target is never read; all access is delegated to the bound adapter.
export const fs: WorkspaceFsAdapter = new Proxy({} as WorkspaceFsAdapter, {
	get(_target, property, _receiver) {
		const adapter = requireFs();
		const value = Reflect.get(adapter, property, adapter);
		return typeof value === 'function' ? value.bind(adapter) : value;
	},
});
