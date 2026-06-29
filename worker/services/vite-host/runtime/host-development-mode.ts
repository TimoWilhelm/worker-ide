/**
 * Async-scoped "host development mode" flag for the vinext build.
 *
 * The vendored plugin bundle reads `globalThis.__VINEXT_HOST_DEV__` to decide
 * whether to emit DEV-style client references — user `"use client"` modules
 * loaded UNBUNDLED from the host dev module server (`/@vinext-client/…`, enabling
 * React Fast Refresh) instead of bundled chunk references (see
 * `scripts/vendor-vite-host.ts` `patchClientReferences`).
 *
 * A bare global would race across concurrent requests in the shared worker
 * isolate (a preview/development build vs. a deploy/production build). Backing
 * it with `AsyncLocalStorage` scopes the flag to the build's async context: the
 * getter resolves per call site to whichever build is currently executing, so
 * deploy builds never see the flag set by a concurrent preview build.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

declare global {
	var __VINEXT_HOST_DEV__: boolean | undefined;
}

const hostDevelopmentModeStorage = new AsyncLocalStorage<boolean>();

let installed = false;

/** Define the `globalThis.__VINEXT_HOST_DEV__` getter the vendored bundle reads. */
function ensureGlobalGetter(): void {
	if (installed) {
		return;
	}
	installed = true;
	Object.defineProperty(globalThis, '__VINEXT_HOST_DEV__', {
		configurable: true,
		get: () => hostDevelopmentModeStorage.getStore() === true,
	});
}

/** Run `function_` with host development mode enabled for its entire async context. */
export function runWithHostDevelopmentMode<R>(function_: () => R): R {
	ensureGlobalGetter();
	return hostDevelopmentModeStorage.run(true, function_);
}
