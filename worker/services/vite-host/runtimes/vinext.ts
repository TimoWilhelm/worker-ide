/**
 * vinext (Next.js App Router on Vite) framework runtime.
 *
 * Builds React Server Components + SSR into a server module set and an unbundled
 * (preview) or bundled (deploy) client. Preview serving delegates to the shared
 * asset-then-SSR router; HMR routes server-component edits through vinext's
 * client dev runtime (`rsc:update` → `hmrReplaceTree`).
 */
import { routeAppRequest } from '../runtime/app-runtime';
import { runWithHostDevelopmentMode } from '../runtime/host-development-mode';
import { seedVinextRuntime } from '../runtime/seed-vinext-runtime';
import { SERVER_RUNTIME_EXTERNALS } from '../runtime/server-externals';
import { isVinextProject } from '../vinext-detection';
import { buildHmrGlue, createRuntimeHost } from './shared';

import type { DurableFrameworkRuntime, ProjectProbe, RuntimePreviewBuild, RuntimeRouteContext } from './types';
import type { MemoryFileSystem } from '../node-fs/memory-file-system';

/** vinext's App Router worker entry — the server module set's main module. */
const APP_ROUTER_ENTRY = '/__vinext__/dist/server/app-router-entry.js';

class VinextRuntime implements DurableFrameworkRuntime {
	readonly id = 'vinext';
	readonly hosting = 'durable' as const;
	readonly serverCompatibilityFlags = ['nodejs_compat', 'enable_nodejs_fs_module'] as const;

	detect(probe: ProjectProbe): boolean {
		return isVinextProject(probe.files);
	}

	createPlugins(): Promise<import('../types').PluginOption[]> {
		return import('../../../../auxiliary/vite-host/vendor/native-plugins.mjs').then(({ vinext }) => vinext());
	}

	seedRuntime(fileSystem: MemoryFileSystem): void {
		seedVinextRuntime(fileSystem);
	}

	async build(snapshot: Record<string, string>, options: { hostDevelopment: boolean }): Promise<RuntimePreviewBuild> {
		const host = await createRuntimeHost(this, snapshot);
		const runBuild = () => host.build([...SERVER_RUNTIME_EXTERNALS], APP_ROUTER_ENTRY);
		// Preview builds run in host-development mode (unbundled, HMR-able client
		// references); deploy builds run plain (fully bundled, standalone).
		await (options.hostDevelopment ? runWithHostDevelopmentMode(runBuild) : runBuild());
		return {
			mainModule: 'index.js',
			serverModules: host.readOutput('/dist/server'),
			clientOutput: host.readOutput('/dist/client'),
			devContext: host.devModuleContext(),
		};
	}

	route(request: Request, context: RuntimeRouteContext): Promise<Response> {
		return routeAppRequest(request, { clientOutput: context.clientOutput, server: context.getServer() });
	}

	hmrGlue(): string {
		return buildHmrGlue({
			// The client build's `import.meta.hot` resolves to this hot context, so
			// vinext's client HMR runtime attaches to the preview runtime's event bus.
			extraSetup: `window.__vinext_client_hot__ = runtime.createHotContext('vinext-client-runtime');`,
			// Server-component change: vinext re-fetches the route's RSC payload and
			// reconciles it in place (hmrReplaceTree), preserving client state.
			softRefreshBody: `if (window.__vinext_client_hot__) { runtime.emitEvent('rsc:update', {}); return; } location.reload();`,
		});
	}
}

export const vinextRuntime: DurableFrameworkRuntime = new VinextRuntime();
