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

import { HIDDEN_ENTRIES, STORAGE_BINDING_NAME, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { fs, runWithProjectStub } from '@worker/lib/project-fs';

import { toBundleServerError } from '../lib/build-server-error';
import { coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';
import { readBindingsConfig } from '../lib/protected-files';
import { createSerialRunner } from '../lib/serial-runner';
import { resolveStorageQuotaForProject } from '../lib/storage-quota';
import { withSpan, type TracingSpan } from '../lib/tracing';
import { VINEXT_PREVIEW_HEADERS } from '../lib/vinext-preview-protocol';
import { isDevelopmentModuleRequest } from '../services/vite-host/runtime/development-module-server';
import { getServerEntrypoint, serverModulesFromOutput } from '../services/vite-host/runtime/loader-runner';
import { getRuntimeById } from '../services/vite-host/runtimes/registry';

import type { DurableFrameworkRuntime, RuntimeBuild } from '../services/vite-host/runtimes/types';
import type { ServerError } from '@shared/types';

/** The default runtime when no id is supplied (the original preview surface). */
const DEFAULT_RUNTIME_ID = 'vinext';

/** Directories never included in the build snapshot. */
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', ...HIDDEN_ENTRIES]);

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
		return runWithProjectStub(filesystemStub, () => this.serve(request, ideOrigin), this.projectRoot);
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
						return this.runExclusive(() => this.env.VITE_HOST.build(snapshot, this.runtimeId, { hostDevelopment: false }));
					},
					{ 'project.id': projectId, 'runtime.id': runtimeId },
				),
			projectRoot,
		);
	}

	private serve(request: Request, ideOrigin: string): Promise<Response> {
		const url = new URL(request.url);
		return withSpan('vinext.serve', () => this.serveTraced(request, url, ideOrigin), {
			'project.id': this.projectId,
			'runtime.id': this.runtimeId,
			'request.path': url.pathname,
			'request.dev_module': isDevelopmentModuleRequest(url.pathname),
		});
	}

	private async serveTraced(request: Request, url: URL, ideOrigin: string): Promise<Response> {
		if (HMR_SCRIPT_PATHS.includes(url.pathname)) {
			const scripts = await this.getHmrScripts();
			return scriptResponse(scripts[url.pathname]);
		}
		if (url.pathname === HMR_GLUE_PATH) {
			return scriptResponse(this.runtime.hmrGlue());
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
					return scriptResponse(code);
				}
			}

			const { build, cacheKey } = await this.buildForCurrentSnapshot();
			const serverEnvironment = await withSpan('vinext.resolveEnv', () => this.resolveServerEnvironment());
			const response = await withSpan('vinext.route', () =>
				this.runtime.route(request, {
					clientOutput: build.clientOutput,
					projectRoot: this.projectRoot,
					getServer: this.serverFactory(build, cacheKey, serverEnvironment),
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
	private async resolveServerEnvironment(): Promise<Record<string, unknown>> {
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
	private buildForCurrentSnapshot(): Promise<{ build: RuntimeBuild; cacheKey: string }> {
		return withSpan('vinext.build', (span) => this.buildForCurrentSnapshotTraced(span));
	}

	private async buildForCurrentSnapshotTraced(span: TracingSpan): Promise<{ build: RuntimeBuild; cacheKey: string }> {
		const snapshot = await this.collectSnapshot();
		const hash = await withSpan('vinext.hashSnapshot', () => hashSnapshot(snapshot));
		span.setAttribute('snapshot.hash', hash.slice(0, 12));
		const cached = this.builds.get(hash);
		if (cached !== undefined) {
			span.setAttribute('cache.hit', true);
			return { build: cached, cacheKey: `${this.projectId}:${hash}` };
		}
		span.setAttribute('cache.hit', false);
		const build = await this.runExclusive(async () => {
			// A build queued behind another may now find this snapshot already built.
			const existing = this.builds.get(hash);
			if (existing !== undefined) {
				return existing;
			}
			// The heavy build runs in the VITE_HOST worker's isolate, not this DO.
			// Bracket it with a preview-only rebuild signal so the IDE can show a
			// rebuilding indicator for the duration of this (slow) vinext build.
			void this.broadcastRebuildStatus('start');
			let built: RuntimeBuild;
			try {
				built = await this.env.VITE_HOST.build(snapshot, this.runtimeId, { hostDevelopment: true });
			} finally {
				void this.broadcastRebuildStatus('end');
			}
			this.builds.set(hash, built);
			// Keep only the two most recent (lightweight) builds to bound memory.
			while (this.builds.size > 2) {
				const oldest = this.builds.keys().next().value;
				if (oldest === undefined) break;
				this.builds.delete(oldest);
			}
			return built;
		});
		return { build, cacheKey: `${this.projectId}:${hash}` };
	}

	/**
	 * Collect the full project tree as a snapshot keyed by root-relative path
	 * (e.g. `/app/page.tsx`), excluding build output and tooling directories.
	 */
	private collectSnapshot(): Promise<Record<string, string>> {
		return withSpan('vinext.collectSnapshot', async (span) => {
			const files: Record<string, string> = {};
			await this.collectInto(files, this.projectRoot, '');
			let bytes = 0;
			for (const content of Object.values(files)) {
				bytes += content.length;
			}
			span.setAttribute('snapshot.file_count', Object.keys(files).length);
			span.setAttribute('snapshot.bytes', bytes);
			return files;
		});
	}

	private async collectInto(files: Record<string, string>, directory: string, relativeBase: string): Promise<void> {
		let entries: { name: string; isDirectory(): boolean }[];
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		await Promise.all(
			entries.map(async (entry) => {
				if (EXCLUDED_DIRECTORIES.has(entry.name)) {
					return;
				}
				const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
				const fullPath = `${directory}/${entry.name}`;
				if (entry.isDirectory()) {
					await this.collectInto(files, fullPath, relativePath);
					return;
				}
				files[`/${relativePath}`] = await fs.readFile(fullPath, 'utf8');
			}),
		);
	}
}

/** A JavaScript module response with no-cache (dev modules change on edit). */
function scriptResponse(code: string): Response {
	return new Response(code, {
		headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
	});
}

/** Hash a project snapshot deterministically to key the build cache. */
async function hashSnapshot(snapshot: Record<string, string>): Promise<string> {
	const serialized = Object.keys(snapshot)
		.toSorted()
		.map((path) => `${path}\u0000${snapshot[path]}`)
		.join('\u0001');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
