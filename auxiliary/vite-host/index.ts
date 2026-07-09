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

import { runWithTracing, withSpan } from '@worker/lib/tracing';

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
	 *
	 * Returns the build as a pre-serialized JSON string, NOT a {@link RuntimeBuild}
	 * object. The build is a `Record<string, string>` of many module sources
	 * (multiple MB); returning it as a structured object forces the Workers RPC
	 * layer to structured-clone every property recursively, which measured at
	 * ~14s for a ~5 MB payload (vs ~0.5s to move the same bytes through R2).
	 * Serializing to a single string here collapses that to one clone primitive,
	 * and the caller parses it back (and can persist the exact string verbatim).
	 */
	async build(snapshot: Record<string, string>, runtimeId: string, options: { hostDevelopment: boolean }): Promise<string> {
		// RPC methods are not "handler" invocations, so the `cloudflare:workers`
		// `tracing` global is unbound here — bind `ctx.tracing` for the call so the
		// build's nested `withSpan` calls actually record spans (see `runWithTracing`).
		return runWithTracing(this.ctx.tracing, () =>
			withSpan(
				'vitehost.build',
				async () => {
					if (runtimeId !== 'vinext') {
						throw new Error(`Unsupported build runtime: ${runtimeId}`);
					}
					const { buildVinext } = await loadEngine();
					const build = await buildVinext(snapshot, options);
					return withSpan('vitehost.serialize', () => JSON.stringify(build));
				},
				{ 'runtime.id': runtimeId, 'host.development': options.hostDevelopment, 'snapshot.file_count': Object.keys(snapshot).length },
			),
		);
	}

	/**
	 * Serve a single HMR dev module from the CURRENT project snapshot (no
	 * rebuild). Returns the module source, or `undefined` if the path is not a
	 * dev module the server produces.
	 */
	async serveDevelopmentModule(pathname: string, snapshot: Record<string, string>): Promise<string | undefined> {
		return runWithTracing(this.ctx.tracing, () =>
			withSpan(
				'vitehost.serveDevModule',
				async () => {
					const { serveVinextDevelopmentModule } = await loadEngine();
					return serveVinextDevelopmentModule(pathname, snapshot);
				},
				{ 'module.path': pathname },
			),
		);
	}
}
