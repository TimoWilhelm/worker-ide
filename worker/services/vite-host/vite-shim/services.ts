/**
 * Host services bridge for the `vite` shim.
 *
 * The shim module (see `./index.ts`) is aliased to `vite` and bundled *into*
 * the native plugin code (vinext, `@vitejs/plugin-rsc`) by esbuild. That bundle
 * runs in its own module realm — a `LOADER` isolate — distinct from the host's
 * module instances. The shim therefore cannot import host functions directly;
 * the host publishes runtime services on a well-known global before evaluating
 * the plugin bundle, and the shim reads them from there.
 *
 * Pure utilities (path normalisation, AST parsing via acorn) need no services
 * and are implemented inline in the shim. Only the operations that require host
 * infrastructure — code transformation (esbuild) and environment loading
 * (filesystem) — are delegated through this bridge.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ViteTransformResult {
	code: string;
	map?: string;
}

/** Services the host must publish for the `vite` shim to be fully functional. */
export interface ViteHostServices {
	/**
	 * Transform TS/JSX source to JS. Mirrors Vite's `transformWithOxc` contract:
	 * `(code, id, options) => { code, map }`. Backed by esbuild in the host.
	 */
	transform(code: string, id: string, options?: { sourcemap?: boolean }): Promise<ViteTransformResult>;
	/** Resolve environment variables for the given mode (Vite's `loadEnv`). */
	loadEnv(mode: string, prefixes: string[]): Record<string, string>;
}

const viteHostServicesStorage = new AsyncLocalStorage<ViteHostServices>();
const VITE_HOST_SERVICES_KEY = '__viteHostServices';

/** Scope host services to one build's async call chain. */
export function runWithViteHostServices<T>(services: ViteHostServices, callback: () => T): T {
	// esbuild invokes plugin callbacks outside the originating async context in
	// workerd. The generated native-plugin bundle reads this shared fallback.
	Reflect.set(globalThis, VITE_HOST_SERVICES_KEY, services);
	return viteHostServicesStorage.run(services, callback);
}

/** Read the published services, or `undefined` if the host has not set them. */
export function getViteHostServices(): ViteHostServices | undefined {
	return viteHostServicesStorage.getStore() ?? Reflect.get(globalThis, VITE_HOST_SERVICES_KEY);
}
