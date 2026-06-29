/**
 * vinext build engine — the heavy half, isolated from the light runtime.
 *
 * Importing this module pulls in esbuild-wasm and the vendored React/RSC +
 * vinext runtime source (~20 MB). It therefore runs in the dedicated
 * `vite-host` worker (see `auxiliary/vite-host`), invoked over RPC by the
 * preview Durable Object and the deploy workflow, so that build memory never
 * counts against the preview DO's isolate budget.
 */
import { ensureEsbuild } from '../esbuild-runtime';
import { MemoryFileSystem } from '../node-fs/memory-file-system';
import { serveDevelopmentModule } from '../runtime/development-module-server';
import { runWithHostDevelopmentMode } from '../runtime/host-development-mode';
import { seedNodeModules } from '../runtime/seed-node-modules';
import { seedVinextRuntime } from '../runtime/seed-vinext-runtime';
import { SERVER_RUNTIME_EXTERNALS } from '../runtime/server-externals';
import { ViteHost } from '../vite-host';
import { stripIdeManagedConfig } from './vinext';

import type { RuntimeBuild } from './types';
import type { PluginOption } from '../types';

/** vinext's App Router worker entry — the server module set's main module. */
const APP_ROUTER_ENTRY = '/__vinext__/dist/server/app-router-entry.js';

/** Load vinext's Vite plugins from the vendored native-plugin bundle. */
function createPlugins(): Promise<PluginOption[]> {
	return import('../../../../auxiliary/vite-host/vendor/native-plugins.mjs').then(({ vinext }) => vinext());
}

/** Build a Vite host over the project snapshot, with vinext's plugins + runtime. */
function createHost(snapshot: Record<string, string>): Promise<ViteHost> {
	return ViteHost.create({
		files: stripIdeManagedConfig(snapshot),
		root: '/',
		command: 'build',
		mode: 'production',
		createPlugins,
		seedRuntime: (fileSystem) => seedVinextRuntime(fileSystem),
	});
}

/**
 * Build the vinext project from a snapshot. `hostDevelopment` selects the
 * preview build (unbundled, HMR-able client references) over the production
 * deploy build (fully bundled, standalone). Returns only the serializable,
 * routable module set — the dev module server rebuilds its own context from the
 * snapshot via {@link serveVinextDevelopmentModule}.
 */
export async function buildVinext(snapshot: Record<string, string>, options: { hostDevelopment: boolean }): Promise<RuntimeBuild> {
	const host = await createHost(snapshot);
	const runBuild = (): Promise<unknown> => host.build([...SERVER_RUNTIME_EXTERNALS], APP_ROUTER_ENTRY);
	await (options.hostDevelopment ? runWithHostDevelopmentMode(runBuild) : runBuild());
	return {
		mainModule: 'index.js',
		serverModules: host.readOutput('/dist/server'),
		clientOutput: host.readOutput('/dist/client'),
	};
}

/**
 * Serve a single HMR dev module (`/@vinext-client/…`, `/@vinext-client-dep/…`)
 * from the CURRENT project snapshot — no full rebuild. The snapshot already
 * carries the live (just-edited) source, and the dev module server only needs
 * the vendored `node_modules` + project tree to resolve, transform, and bundle
 * the requested module. Returns the module source, or `undefined` if the path
 * is not a dev module the server produces.
 */
export async function serveVinextDevelopmentModule(pathname: string, snapshot: Record<string, string>): Promise<string | undefined> {
	const esbuild = await ensureEsbuild();
	const fileSystem = MemoryFileSystem.fromSnapshot(stripIdeManagedConfig(snapshot));
	seedNodeModules(fileSystem);
	seedVinextRuntime(fileSystem);
	const result = await serveDevelopmentModule(pathname, { esbuild, fileSystem });
	return result?.code;
}
