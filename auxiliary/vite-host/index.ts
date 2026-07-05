/**
 * vite-host worker — runs the heavy vinext build (esbuild-wasm + the vendored
 * React/RSC + vinext runtime, ~20 MB) in its own isolate, off the preview
 * Durable Object's 128 MB budget.
 *
 * The preview DO and the deploy workflow invoke this worker over an RPC service
 * binding (`VITE_HOST`): `build` returns the routable module set for a project
 * snapshot, and `serveDevelopmentModule` serves a single HMR dev module from the
 * current snapshot. The worker is pure compute — it holds no bindings and no
 * durable state; warmth/caching lives in the calling DO.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';

import { withSpan } from '@worker/lib/tracing';

import type { RuntimeBuild } from '@worker/services/vite-host/runtimes/types';

/**
 * Load the build engine lazily, on first use. Its module graph is large (the
 * vendored React/RSC source) and contains React-server modules with top-level
 * side effects, so keeping it out of the worker's startup path makes the isolate
 * boot cheaply; the engine only evaluates inside a real `build` call.
 */
const loadEngine = () => withSpan('vitehost.loadEngine', () => import('@worker/services/vite-host/runtimes/vinext-build'));

export default class ViteHostWorker extends WorkerEntrypoint {
	/**
	 * This worker is invoked only via RPC (the `VITE_HOST` service binding); it
	 * serves no HTTP traffic. A `fetch` handler is still required so the uploaded
	 * script registers an event handler (Cloudflare rejects a handler-less script
	 * with error 10068).
	 */
	async fetch(): Promise<Response> {
		return new Response('vite-host-worker is RPC-only', { status: 404 });
	}

	/**
	 * Build a project snapshot into a routable server module set + client output.
	 * `hostDevelopment` selects the preview build (unbundled, HMR-able client
	 * references) over the production deploy build (fully bundled, standalone).
	 */
	async build(snapshot: Record<string, string>, runtimeId: string, options: { hostDevelopment: boolean }): Promise<RuntimeBuild> {
		return withSpan(
			'vitehost.build',
			async () => {
				if (runtimeId !== 'vinext') {
					throw new Error(`Unsupported build runtime: ${runtimeId}`);
				}
				const { buildVinext } = await loadEngine();
				return buildVinext(snapshot, options);
			},
			{ 'runtime.id': runtimeId, 'host.development': options.hostDevelopment, 'snapshot.file_count': Object.keys(snapshot).length },
		);
	}

	/**
	 * Serve a single HMR dev module from the CURRENT project snapshot (no
	 * rebuild). Returns the module source, or `undefined` if the path is not a
	 * dev module the server produces.
	 */
	async serveDevelopmentModule(pathname: string, snapshot: Record<string, string>): Promise<string | undefined> {
		return withSpan(
			'vitehost.serveDevModule',
			async () => {
				const { serveVinextDevelopmentModule } = await loadEngine();
				return serveVinextDevelopmentModule(pathname, snapshot);
			},
			{ 'module.path': pathname },
		);
	}
}
