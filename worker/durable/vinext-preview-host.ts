/**
 * Per-project Durable Object that owns a project's warm preview build.
 *
 * The DO is framework-agnostic: it holds the build as instance state and
 * delegates every framework-specific decision (plugins, build, preview routing,
 * HMR glue, server compatibility flags) to the {@link FrameworkRuntime} selected
 * from the registry. One DO per project (deterministic `getByName` routing) keeps
 * the build warm and single-threaded for the whole preview/HMR session so the dev
 * module server and React Fast Refresh share one stable, low-latency context.
 * After an eviction the first request transparently rebuilds and warms the DO.
 *
 * The DO binds the project filesystem (cross-DO RPC to `DurableObjectFilesystem`)
 * for its async context. The server module set runs in a `LOADER` isolate (no
 * eval); only the client is served unbundled for HMR.
 */
import { DurableObject, exports } from 'cloudflare:workers';

import { SNAPSHOT_EXCLUDED_DIRECTORIES, STORAGE_BINDING_NAME, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { runWithProjectStub } from '@worker/lib/project-fs';

import { toBundleServerError } from '../lib/build-server-error';
import { coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';
import { readBindingsConfig } from '../lib/protected-files';
import { createSerialRunner } from '../lib/serial-runner';
import { hashSnapshot } from '../lib/snapshot-hash';
import { resolveStorageQuotaForProject } from '../lib/storage-quota';
import { withSpan, type TracingSpan } from '../lib/tracing';
import { VINEXT_PREVIEW_HEADERS } from '../lib/vinext-preview-protocol';
import {
	DEPENDENCY_PREFIX,
	DEPENDENCY_VERSION_PARAM,
	isDevelopmentModuleRequest,
} from '../services/vite-host/runtime/development-module-server';
import { getServerEntrypoint, serverModulesFromOutput } from '../services/vite-host/runtime/loader-runner';
import { getRuntimeById } from '../services/vite-host/runtimes/registry';

import type { DurableFrameworkRuntime, RuntimeBuild } from '../services/vite-host/runtimes/types';
import type { ServerError } from '@shared/types';

/** The default runtime when no id is supplied (the original preview surface). */
const DEFAULT_RUNTIME_ID = 'vinext';

/**
 * Internal preview script paths, injected into the SSR HTML in this load order.
 * Mirrors the static (react-spa) preview's script set so vinext previews get the
 * same IDE integrations: HMR, the chii/chobitsu Chrome DevTools Protocol bridge
 * (console + network relay), and the element picker ("send to agent" overlay).
 * `chobitsu` must load before `chobitsu_init` (which uses its global).
 */
const HMR_SCRIPT_PATHS = [
	'/__vinext_react_refresh.js',
	'/__vinext_error_overlay.js',
	'/__vinext_preview_runtime.js',
	'/__vinext_hmr_client.js',
	'/__vinext_chobitsu.js',
	'/__vinext_chobitsu_init.js',
	'/__vinext_element_picker.js',
];

/** Path serving the runtime's browser HMR glue. */
const HMR_GLUE_PATH = '/__vinext_hmr_glue.js';

/**
 * Cache lifetime (seconds) for the IDE's static scaffolding scripts. They change
 * only when the IDE itself is redeployed (they sit at stable, unversioned URLs),
 * so an hour of staleness is harmless while eliminating a per-load refetch of
 * every scaffolding script through the single-threaded preview DO.
 */
const STATIC_SCRIPT_CACHE_MAX_AGE_SECONDS = 3600;

/**
 * R2 key prefix for the persistent (L2) build cache in the shared
 * `STORAGE_BUCKET`. Deliberately outside the user-visible `projects/<id>/`
 * scope enforced by {@link STORAGE_KEY_PREFIX}: objects here are never reachable
 * through a project's `ObjectStorageBinding` and are not counted against its
 * storage quota (which only lists the `projects/` prefix). Bump the version
 * suffix to invalidate all persisted builds after a build-format change.
 */
const BUILD_CACHE_KEY_PREFIX = '__vinext-build-cache__/v1/';

export class VinextPreviewHost extends DurableObject<Env> {
	/**
	 * Warm builds keyed by snapshot hash. Capped — only recent builds kept. These
	 * are the lightweight, routable outputs (module maps); the heavy build itself
	 * (esbuild + the vendored React/RSC source) runs in the `VITE_HOST` worker, so
	 * the build never loads onto this Durable Object's isolate.
	 */
	private readonly builds = new Map<string, RuntimeBuild>();
	private projectId = '';
	private projectRoot = '/project';
	private runtimeId = DEFAULT_RUNTIME_ID;
	/** Lazily-loaded HMR script sources (`path → source`). */
	private hmrScripts?: Record<string, string>;
	/**
	 * In-flight snapshot collection, shared by concurrent callers. A single page
	 * load fires the HTML navigation plus many asset/module subrequests almost
	 * simultaneously; without coalescing, each would read the entire project tree
	 * into its own heap copy over cross-DO fs RPC. Single-flighting bounds peak
	 * isolate memory to one snapshot and avoids redundant full-tree reads. Cleared
	 * as soon as the collection settles, so the next request re-reads fresh state
	 * (no staleness — an edit lands as a new request after this burst resolves).
	 */
	private snapshotInFlight?: Promise<Record<string, string>>;
	/**
	 * Server environment (Cloudflare bindings) memoized by build cache key. The
	 * bindings derive from `wrangler.jsonc`, which is part of the snapshot the
	 * cache key hashes, so a config change yields a new key and re-resolves. This
	 * spares every route render (HTML, `/?_rsc`, assets) a redundant cross-DO
	 * `wrangler.jsonc` read and D1 quota lookup.
	 */
	private serverEnvironmentMemo?: { cacheKey: string; environment: Record<string, unknown> };
	/** Whether the coordinator has been told this project uses the surface preview. */
	private coordinatorMarked = false;
	/**
	 * Serializes builds within this DO so a burst of cold-open requests (HTML +
	 * assets) triggers a single build for a given snapshot rather than several
	 * concurrent `VITE_HOST` builds.
	 */
	private readonly runExclusive = createSerialRunner();

	/** The (durable) framework runtime selected for this project. */
	private get runtime(): DurableFrameworkRuntime {
		const runtime = getRuntimeById(this.runtimeId);
		if (runtime === undefined || runtime.hosting !== 'durable') {
			throw new Error(`Not a durable framework runtime: ${this.runtimeId}`);
		}
		return runtime;
	}

	async fetch(request: Request): Promise<Response> {
		this.projectId = request.headers.get(VINEXT_PREVIEW_HEADERS.projectId) ?? this.projectId;
		this.projectRoot = request.headers.get(VINEXT_PREVIEW_HEADERS.projectRoot) ?? this.projectRoot;
		this.runtimeId = request.headers.get(VINEXT_PREVIEW_HEADERS.runtimeId) ?? this.runtimeId;
		const ideOrigin = request.headers.get(VINEXT_PREVIEW_HEADERS.ideOrigin) ?? '';
		const snapshotHashHint = request.headers.get(VINEXT_PREVIEW_HEADERS.snapshotHash) ?? undefined;

		// Mark this project so the coordinator drives preview HMR through the
		// `vinext:hmr` event, letting the runtime own state preservation.
		if (!this.coordinatorMarked) {
			this.coordinatorMarked = true;
			try {
				await this.markPreview();
			} catch {
				this.coordinatorMarked = false;
			}
		}

		const filesystemStub = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, this.projectId));
		return runWithProjectStub(filesystemStub, () => this.serve(request, ideOrigin, snapshotHashHint), this.projectRoot);
	}

	private markPreview(): Promise<void> {
		return withSpan('vinext.markPreview', () => coordinatorNamespace.getByName(`project:${this.projectId}`).markVinextPreview());
	}

	/**
	 * Produce a production deploy build (server module set + client assets) for
	 * the project. Runs in this per-project DO so the build is single-threaded and
	 * isolated from the request-serving worker; the deploy workflow uploads the
	 * returned bundle directly (it is never persisted as workflow step state).
	 */
	async buildForDeploy(projectId: string, projectRoot: string, runtimeId: string): Promise<RuntimeBuild> {
		this.projectId = projectId;
		this.projectRoot = projectRoot;
		this.runtimeId = runtimeId;
		const filesystemStub = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, projectId));
		return runWithProjectStub(
			filesystemStub,
			() =>
				withSpan(
					'vinext.buildForDeploy',
					async () => {
						const snapshot = await this.collectSnapshot();
						const serialized = await this.runExclusive(() =>
							this.env.VITE_HOST.build(snapshot, this.runtimeId, { hostDevelopment: false }),
						);
						const build = parseRuntimeBuild(JSON.parse(serialized));
						if (build === undefined) {
							throw new Error('vite-host returned a malformed build payload');
						}
						return build;
					},
					{ 'project.id': projectId, 'runtime.id': runtimeId },
				),
			projectRoot,
		);
	}

	private serve(request: Request, ideOrigin: string, snapshotHashHint?: string): Promise<Response> {
		const url = new URL(request.url);
		return withSpan('vinext.serve', () => this.serveTraced(request, url, ideOrigin, snapshotHashHint), {
			'project.id': this.projectId,
			'runtime.id': this.runtimeId,
			'request.path': url.pathname,
			'request.dev_module': isDevelopmentModuleRequest(url.pathname),
		});
	}

	private async serveTraced(request: Request, url: URL, ideOrigin: string, snapshotHashHint?: string): Promise<Response> {
		if (HMR_SCRIPT_PATHS.includes(url.pathname)) {
			const scripts = await this.getHmrScripts();
			return scriptResponse(scripts[url.pathname], 'static');
		}
		if (url.pathname === HMR_GLUE_PATH) {
			return scriptResponse(this.runtime.hmrGlue(), 'static');
		}

		try {
			// Dev module requests (HMR re-imports) must be cheap: serve the changed
			// client module from its CURRENT source against the warm build's context
			// (node_modules + React globals) — no full rebuild.
			if (isDevelopmentModuleRequest(url.pathname)) {
				const code = await withSpan(
					'vinext.devModule',
					async () => {
						const snapshot = await this.collectSnapshot();
						return this.env.VITE_HOST.serveDevelopmentModule(url.pathname, snapshot);
					},
					{ 'module.path': url.pathname },
				);
				if (code !== undefined) {
					// A dependency URL carries a cache token (`?v=`): its content is stable
					// for that token, so the browser caches it immutably and stops
					// re-requesting it on every load (which otherwise serialize behind this
					// single-threaded DO). User client modules stay no-cache — they change
					// on edit and must always reflect the latest source.
					const cacheable = url.pathname.startsWith(DEPENDENCY_PREFIX) && url.searchParams.has(DEPENDENCY_VERSION_PARAM);
					return scriptResponse(code, cacheable ? 'immutable' : 'no-cache');
				}
			}

			const { build, cacheKey } = await this.buildForCurrentSnapshot(snapshotHashHint);
			const serverEnvironment = await withSpan('vinext.resolveEnv', () => this.resolveServerEnvironment(cacheKey));
			const response = await withSpan('vinext.route', () =>
				this.runtime.route(request, {
					clientOutput: build.clientOutput,
					projectRoot: this.projectRoot,
					getServer: this.serverFactory(build, cacheKey, serverEnvironment),
					buildId: cacheKey,
				}),
			);
			// A server-side render error is returned by the framework as a normal
			// HTTP 500 page (it never throws out to the catch below), so surface it
			// through the same overlay + broadcast as build errors instead of letting
			// the silent framework error page reach the iframe.
			if (response.status >= 500) {
				const surfaced = await this.surfaceServerRenderError(response, request, ideOrigin);
				if (surfaced !== undefined) {
					return surfaced;
				}
			}
			if (response.headers.get('Content-Type')?.includes('text/html')) {
				return this.injectHmrRuntime(response, request, ideOrigin);
			}
			return response;
		} catch (error) {
			return this.serveBuildError(error, request, ideOrigin);
		}
	}

	/**
	 * Resolve the Cloudflare bindings exposed to the running vinext server isolate
	 * as `env` (and thus `import { env } from "cloudflare:workers"`). Mirrors the
	 * React-SPA preview path: the curated `STORAGE` R2 binding is provided via the
	 * `ObjectStorageBinding` entrypoint when enabled in the project's bindings config.
	 */
	private async resolveServerEnvironment(cacheKey: string): Promise<Record<string, unknown>> {
		if (this.serverEnvironmentMemo?.cacheKey === cacheKey) {
			return this.serverEnvironmentMemo.environment;
		}
		const environment = await this.resolveServerEnvironmentUncached();
		this.serverEnvironmentMemo = { cacheKey, environment };
		return environment;
	}

	private async resolveServerEnvironmentUncached(): Promise<Record<string, unknown>> {
		const bindingsConfig = await readBindingsConfig(this.projectRoot);
		const environment: Record<string, unknown> = {};
		if (bindingsConfig.storage) {
			const quotaBytes = await resolveStorageQuotaForProject(this.projectId, this.env.DB);
			environment[STORAGE_BINDING_NAME] = exports.ObjectStorageBinding({ props: { projectId: this.projectId, quotaBytes } });
		}
		return environment;
	}

	/** A lazy server-isolate factory for a build (instantiated only when needed). */
	private serverFactory(
		build: RuntimeBuild,
		cacheKey: string,
		environment: Record<string, unknown>,
	): () => ReturnType<typeof getServerEntrypoint> {
		let server: ReturnType<typeof getServerEntrypoint> | undefined;
		return () => {
			server ??= getServerEntrypoint({
				loader: this.env.LOADER,
				cacheKey: `${this.runtimeId}:${cacheKey}`,
				moduleSet: {
					compatibilityDate: WORKERS_COMPATIBILITY_DATE,
					compatibilityFlags: [...this.runtime.serverCompatibilityFlags],
					mainModule: build.mainModule,
					modules: serverModulesFromOutput(build.serverModules),
					...(Object.keys(environment).length > 0 ? { env: environment } : {}),
				},
			});
			return server;
		};
	}

	/**
	 * Surface a build failure through the preview error overlay, matching the
	 * legacy preview pipeline. The error is broadcast so any already-open preview
	 * shows it on a failed rebuild, and the response itself renders the overlay:
	 * an HTML navigation gets a minimal document that loads the overlay script,
	 * while a script/asset request gets a module that calls into the overlay.
	 */
	private serveBuildError(error: unknown, request: Request, ideOrigin: string): Promise<Response> {
		return this.renderServerError(toBundleServerError(error), request, ideOrigin);
	}

	/**
	 * vinext renders a server-side render failure as a normal HTTP 500
	 * `__next_error__` page, which `route()` returns as a Response — so it never
	 * reaches the build-error catch above. Detect that page and surface it through
	 * the same overlay + broadcast, turning a silent framework error page into
	 * actionable in-IDE feedback. Returns `undefined` for any other 5xx response
	 * (e.g. an intentional 500 from the app), which is then passed through.
	 *
	 * The detailed message/stack is not recoverable here: the server is built in
	 * production mode, where the framework strips the error to a digest before
	 * responding (a development server build is required to surface the message,
	 * which currently regresses RSC rendering — tracked separately).
	 */
	private async surfaceServerRenderError(response: Response, request: Request, ideOrigin: string): Promise<Response | undefined> {
		const body = await response.clone().text();
		if (!body.includes('id="__next_error__"')) {
			return undefined;
		}
		const serverError: ServerError = {
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			type: 'runtime',
			message:
				'The server failed while rendering this route (HTTP 500). A Server Component threw during render — check this route and any packages it imports for runtime or SSR-incompatible code (for example, accessing browser globals like `window` or `document` on the server).',
		};
		return this.renderServerError(serverError, request, ideOrigin);
	}

	private async renderServerError(serverError: ServerError, request: Request, ideOrigin: string): Promise<Response> {
		try {
			await coordinatorNamespace.getByName(`project:${this.projectId}`).sendMessage({ type: 'server-error', error: serverError });
		} catch {
			// The overlay still renders from the response below when the broadcast
			// cannot be delivered (e.g. no coordinator sockets yet).
		}
		const payload = JSON.stringify(serverError)
			.replaceAll('<', String.raw`\u003c`)
			.replaceAll('>', String.raw`\u003e`);
		if (request.headers.get('Accept')?.includes('text/html')) {
			const config = { ideOrigin, projectId: this.projectId };
			const html =
				`<!doctype html><html><head><meta charset="utf-8">` +
				`<script>window.__PREVIEW_CONFIG=${JSON.stringify(config).replaceAll('<', String.raw`\u003c`)}</script>` +
				`<script src="/__vinext_error_overlay.js"></script></head>` +
				`<body><script>window.showErrorOverlay(${payload})</script></body></html>`;
			return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' } });
		}
		const module = `if(typeof showErrorOverlay==='function'){showErrorOverlay(${payload})}else{console.error(${payload}.message)}`;
		return scriptResponse(module);
	}

	/** Inject the preview config + HMR runtime scripts into an SSR HTML response. */
	private injectHmrRuntime(response: Response, request: Request, ideOrigin: string): Promise<Response> {
		return withSpan('vinext.injectHmr', () => this.injectHmrRuntimeTraced(response, request, ideOrigin));
	}

	private async injectHmrRuntimeTraced(response: Response, request: Request, ideOrigin: string): Promise<Response> {
		const html = await response.text();
		const requestUrl = new URL(request.url);
		const protocol = requestUrl.protocol === 'https:' ? 'wss:' : 'ws:';
		const config = {
			wsUrl: `${protocol}//${requestUrl.host}/__ws`,
			ideOrigin,
			projectId: this.projectId,
			bootVersion: await this.bootVersion(),
		};
		// Classic scripts run before the deferred module bootstrap, so the React
		// Refresh preamble installs `__RefreshRuntime`/`$RefreshReg$` before any
		// client module loads.
		const injected = [
			`<script>window.__PREVIEW_CONFIG=${JSON.stringify(config).replaceAll('<', String.raw`\u003c`)}</script>`,
			...HMR_SCRIPT_PATHS.map((path) => `<script src="${path}"></script>`),
			`<script src="${HMR_GLUE_PATH}"></script>`,
		].join('');
		const withScripts = html.includes('<head>') ? html.replace('<head>', `<head>${injected}`) : injected + html;
		return new Response(withScripts, { status: response.status, headers: response.headers });
	}

	/**
	 * Load the preview HMR script sources on first use. These are `?raw-minified`
	 * browser scripts; importing them lazily keeps the DO module's boot-time
	 * evaluation free of browser-only code and runs only inside a request.
	 */
	private async getHmrScripts(): Promise<Record<string, string>> {
		if (this.hmrScripts === undefined) {
			const [refresh, overlay, runtime, hmrClient, chobitsu, chobitsuInit, elementPicker] = await withSpan('vinext.loadHmrScripts', () =>
				Promise.all([
					import('@worker/lib/preview-scripts/react-refresh-preamble.js?raw-minified'),
					import('@worker/lib/preview-scripts/error-overlay.js?raw-minified'),
					import('@worker/lib/preview-scripts/preview-runtime.js?raw-minified'),
					import('@worker/lib/preview-scripts/hmr-client.js?raw-minified'),
					import('chobitsu?raw-minified'),
					import('@worker/lib/preview-scripts/chobitsu-init.js?raw-minified'),
					import('@worker/lib/preview-scripts/element-picker.js?raw-minified'),
				]),
			);
			this.hmrScripts = {
				'/__vinext_react_refresh.js': refresh.source,
				'/__vinext_error_overlay.js': overlay.source,
				'/__vinext_preview_runtime.js': runtime.source,
				'/__vinext_hmr_client.js': hmrClient.source,
				'/__vinext_chobitsu.js': chobitsu.source,
				'/__vinext_chobitsu_init.js': chobitsuInit.source,
				'/__vinext_element_picker.js': elementPicker.source,
			};
		}
		return this.hmrScripts;
	}

	/**
	 * Signal the coordinator that a build is starting/finishing so preview sockets
	 * can surface a rebuilding indicator. Best-effort: a missing coordinator (no
	 * sockets yet, e.g. the initial cold build) simply drops the cosmetic signal.
	 */
	private async broadcastRebuildStatus(status: 'start' | 'end'): Promise<void> {
		try {
			await coordinatorNamespace.getByName(`project:${this.projectId}`).broadcastPreviewRebuildStatus(status);
		} catch {
			// The rebuild indicator is non-critical; ignore delivery failures.
		}
	}

	private async bootVersion(): Promise<number> {
		try {
			return await coordinatorNamespace.getByName(`project:${this.projectId}`).getUpdateVersion();
		} catch {
			return 0;
		}
	}

	/** Build (or reuse) for the current project snapshot. */
	private buildForCurrentSnapshot(snapshotHashHint?: string): Promise<{ build: RuntimeBuild; cacheKey: string }> {
		return withSpan('vinext.build', (span) => this.buildForCurrentSnapshotTraced(span, snapshotHashHint));
	}

	private async buildForCurrentSnapshotTraced(
		span: TracingSpan,
		snapshotHashHint?: string,
	): Promise<{ build: RuntimeBuild; cacheKey: string }> {
		// Probe the warm build cache with a tree-free hash first: the filesystem DO
		// hashes its own SQLite tree locally, so a cache hit serves the build
		// WITHOUT transferring the whole project on every request. Only a miss
		// (a genuine edit or cold DO) pays for the full snapshot fetch.
		//
		// The preview bootstrap already hashed the tree in its own round trip and
		// passed the result here, so the hot path reuses it and avoids a second
		// cross-DO hop. When absent (e.g. the deploy path), fall back to asking the
		// filesystem DO directly.
		const stub = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, this.projectId));
		const probeHash = snapshotHashHint ?? (await withSpan('vinext.snapshotHash', () => stub.snapshotHash(SNAPSHOT_EXCLUDED_DIRECTORIES)));
		span.setAttribute('snapshot.hash', probeHash.slice(0, 12));
		const probed = this.builds.get(probeHash);
		if (probed !== undefined) {
			span.setAttribute('cache.hit', true);
			return { build: probed, cacheKey: `${this.projectId}:${probeHash}` };
		}
		span.setAttribute('cache.hit', false);
		// Miss: fetch the tree and re-hash the exact contents we build from, so the
		// cache key is authoritative even if an edit raced the probe above.
		const snapshot = await this.collectSnapshot();
		const hash = await withSpan('vinext.hashSnapshot', () => hashSnapshot(snapshot));
		const cached = this.builds.get(hash);
		if (cached !== undefined) {
			return { build: cached, cacheKey: `${this.projectId}:${hash}` };
		}
		const build = await this.runExclusive(async () => {
			// A build queued behind another may now find this snapshot already built.
			const existing = this.builds.get(hash);
			if (existing !== undefined) {
				return existing;
			}
			// L2: a warm build for this exact snapshot may survive DO eviction in R2.
			// Snapshot-hash keying makes this staleness-proof — any edit yields a new
			// hash, so a hit is always the correct build for the current tree.
			const persisted = await this.readPersistedBuild(hash);
			if (persisted !== undefined) {
				span.setAttribute('cache.persisted_hit', true);
				this.rememberBuild(hash, persisted);
				return persisted;
			}
			span.setAttribute('cache.persisted_hit', false);
			// The heavy build runs in the VITE_HOST worker's isolate, not this DO.
			// Bracket it with a preview-only rebuild signal so the IDE can show a
			// rebuilding indicator for the duration of this (slow) vinext build.
			void this.broadcastRebuildStatus('start');
			let serialized: string;
			try {
				serialized = await this.env.VITE_HOST.build(snapshot, this.runtimeId, { hostDevelopment: true });
			} finally {
				void this.broadcastRebuildStatus('end');
			}
			const built = parseRuntimeBuild(JSON.parse(serialized));
			if (built === undefined) {
				throw new Error('vite-host returned a malformed build payload');
			}
			this.rememberBuild(hash, built);
			// Persist to R2 so a future cold DO skips the slow rebuild. Fire-and-forget:
			// a failed/slow write must never block serving this already-built preview.
			// Reuse the exact string vite-host sent — no re-serialization.
			this.persistBuild(hash, serialized);
			return built;
		});
		return { build, cacheKey: `${this.projectId}:${hash}` };
	}

	/** Insert a build into the in-memory cache, evicting to keep at most two. */
	private rememberBuild(hash: string, build: RuntimeBuild): void {
		this.builds.set(hash, build);
		// Keep only the two most recent (lightweight) builds to bound memory.
		while (this.builds.size > 2) {
			const oldest = this.builds.keys().next().value;
			if (oldest === undefined) break;
			this.builds.delete(oldest);
		}
	}

	/** R2 object key for a persisted build, scoped by project + runtime + snapshot hash. */
	private persistedBuildKey(hash: string): string {
		return `${BUILD_CACHE_KEY_PREFIX}${this.projectId}/${this.runtimeId}/${hash}.json`;
	}

	/**
	 * Read a previously-persisted build from R2. Returns `undefined` on miss,
	 * malformed payload, or any R2 error — every failure mode falls back to a
	 * clean rebuild rather than risking a bad or stale preview.
	 */
	private readPersistedBuild(hash: string): Promise<RuntimeBuild | undefined> {
		return withSpan('vinext.buildCache.read', async (span) => {
			try {
				const object = await this.env.STORAGE_BUCKET.get(this.persistedBuildKey(hash));
				if (object === null) {
					span.setAttribute('cache.persisted_hit', false);
					return;
				}
				const parsed = parseRuntimeBuild(JSON.parse(await object.text()));
				span.setAttribute('cache.persisted_hit', parsed !== undefined);
				return parsed;
			} catch {
				span.setAttribute('cache.persisted_hit', false);
				return;
			}
		});
	}

	/**
	 * Persist a serialized build to R2 (fire-and-forget). Takes the already-
	 * serialized JSON string (as returned by vite-host and stored in memory's
	 * source) to avoid re-stringifying multiple MB. Keyed by snapshot hash so
	 * writes are idempotent; a stale R2 lifecycle rule on
	 * {@link BUILD_CACHE_KEY_PREFIX} reclaims artifacts for snapshots that stop
	 * being requested.
	 */
	private persistBuild(hash: string, serialized: string): void {
		// waitUntil (not a bare `void`) so the cache write survives the DO going
		// idle right after responding — otherwise the put can be cancelled and the
		// next cold open needlessly rebuilds. Best-effort: a failure just means a
		// future miss, never a broken response.
		this.ctx.waitUntil(
			this.env.STORAGE_BUCKET.put(this.persistedBuildKey(hash), serialized).catch(() => {
				// Best-effort cache write; the in-memory build already serves this request.
			}),
		);
	}

	/**
	 * Collect the full project tree as a snapshot keyed by root-relative path
	 * (e.g. `/app/page.tsx`), excluding build output and tooling directories.
	 *
	 * Concurrent calls (the burst of subrequests behind one navigation) share a
	 * single in-flight collection to bound peak memory and avoid redundant
	 * full-tree fs RPC reads; the shared promise is cleared once it settles.
	 */
	private collectSnapshot(): Promise<Record<string, string>> {
		this.snapshotInFlight ??= this.collectSnapshotUncached().finally(() => {
			this.snapshotInFlight = undefined;
		});
		return this.snapshotInFlight;
	}

	private collectSnapshotUncached(): Promise<Record<string, string>> {
		return withSpan('vinext.collectSnapshot', async (span) => {
			// One cross-DO round trip: the filesystem DO walks its own SQLite-backed
			// tree locally (~0ms per read) instead of the worker paying a readdir +
			// readFile RPC latency per node on every preview request.
			const stub = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, this.projectId));
			const files = await stub.collectProjectSnapshot(SNAPSHOT_EXCLUDED_DIRECTORIES);
			let bytes = 0;
			for (const content of Object.values(files)) {
				bytes += content.length;
			}
			span.setAttribute('snapshot.file_count', Object.keys(files).length);
			span.setAttribute('snapshot.bytes', bytes);
			return files;
		});
	}
}

/**
 * A JavaScript module response.
 *
 * `cache` selects the policy:
 * - `'no-cache'` (default) — for live user modules (HMR dev modules) that change
 *   on edit; the browser must revalidate every time so a preview never serves
 *   stale user code.
 * - `'static'` — for the IDE's own scaffolding scripts (HMR client glue, error
 *   overlay, element picker, …). These are constant for a given deploy and carry
 *   no user code, so a moderate TTL is safe and lets the browser skip refetching
 *   them (and re-queuing behind the single-threaded preview DO) on every load.
 */
function scriptResponse(code: string, cache: 'no-cache' | 'static' | 'immutable' = 'no-cache'): Response {
	const cacheControl = cacheControlForScript(cache);
	return new Response(code, {
		headers: { 'Content-Type': 'application/javascript', 'Cache-Control': cacheControl },
	});
}

function cacheControlForScript(cache: 'no-cache' | 'static' | 'immutable'): string {
	if (cache === 'immutable') {
		return 'public, max-age=31536000, immutable';
	}
	if (cache === 'static') {
		return `public, max-age=${STATIC_SCRIPT_CACHE_MAX_AGE_SECONDS}`;
	}
	return 'no-cache';
}

/** True when `value` is a plain object whose every own value is a string. */
function isStringMap(value: unknown): value is Record<string, string> {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	return Object.values(value).every((entry) => typeof entry === 'string');
}

/**
 * Validate a value parsed from the persistent build cache before trusting it.
 * The R2 payload is our own JSON, but guarding the shape keeps a corrupt or
 * format-drifted object from being served instead of triggering a clean rebuild.
 */
export function parseRuntimeBuild(value: unknown): RuntimeBuild | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	if (!('mainModule' in value) || !('serverModules' in value) || !('clientOutput' in value)) {
		return undefined;
	}
	const { mainModule, serverModules, clientOutput } = value;
	if (typeof mainModule !== 'string' || !isStringMap(serverModules) || !isStringMap(clientOutput)) {
		return undefined;
	}
	return { mainModule, serverModules, clientOutput };
}
