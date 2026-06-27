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

declare global {
	var __VITE_HOST_SERVICES__: ViteHostServices | undefined;
}

/** Publish host services. Called by the host before evaluating plugin code. */
export function installViteHostServices(services: ViteHostServices): void {
	globalThis.__VITE_HOST_SERVICES__ = services;
}

/** Read the published services, or `undefined` if the host has not set them. */
export function getViteHostServices(): ViteHostServices | undefined {
	return globalThis.__VITE_HOST_SERVICES__;
}
