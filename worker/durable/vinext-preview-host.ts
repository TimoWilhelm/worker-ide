/**
 * Per-project Durable Object that owns a vinext project's warm preview build.
 *
 * One DO per project (deterministic `getByName` routing) holds the RSC + SSR +
 * client build as instance state, keeping it warm and single-threaded for the
 * whole preview/HMR session so the dev module server and React Fast Refresh
 * share one stable, low-latency build context across edits. After an eviction
 * the first request transparently rebuilds and warms the DO again.
 *
 * The DO binds the project filesystem (cross-DO RPC to `DurableObjectFilesystem`)
 * for its async context, then delegates to the build/serve logic. SSR/RSC run in
 * a `LOADER` isolate (no eval); only the client is served unbundled for HMR.
 */
import { DurableObject } from 'cloudflare:workers';

import { HIDDEN_ENTRIES, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { fs, runWithProjectStub } from '@worker/lib/project-fs';

import { toBundleServerError } from '../lib/build-server-error';
import { coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';
import { VINEXT_PREVIEW_HEADERS } from '../lib/vinext-preview-protocol';
import { routeAppRequest } from '../services/vite-host/runtime/app-runtime';
import { buildVinextForDeploy, type VinextDeployBuild } from '../services/vite-host/runtime/deploy-build';
import {
	isDevelopmentModuleRequest,
	serveDevelopmentModule,
	type DevelopmentModuleContext,
} from '../services/vite-host/runtime/development-module-server';
import { runWithHostDevelopmentMode } from '../services/vite-host/runtime/host-development-mode';
import { getServerEntrypoint, serverModulesFromOutput, type LoaderModule } from '../services/vite-host/runtime/loader-runner';
import { SERVER_RUNTIME_EXTERNALS } from '../services/vite-host/runtime/server-externals';
import { ViteHost } from '../services/vite-host/vite-host';

/** vinext's App Router worker entry, seeded into the in-memory runtime tree. */
const APP_ROUTER_ENTRY = '/__vinext__/dist/server/app-router-entry.js';

/** Compatibility flags the built server bundle requires in its isolate. */
const SERVER_COMPATIBILITY_FLAGS = ['nodejs_compat', 'enable_nodejs_fs_module'];

/** Directories never included in the build snapshot. */
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', ...HIDDEN_ENTRIES]);

/** Internal HMR script paths, injected into the SSR HTML in this load order. */
const HMR_SCRIPT_PATHS = [
	'/__vinext_react_refresh.js',
	'/__vinext_error_overlay.js',
	'/__vinext_preview_runtime.js',
	'/__vinext_hmr_client.js',
];

/** Source extensions Vite (and this glue) treat as stylesheets. */
const STYLE_EXTENSION_PATTERN = String.raw`\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)([?#].*)?$`;

/**
 * Browser glue bridging the coordinator's `vinext:hmr` events to a surgical
 * update, mirroring Vite's HMR boundaries:
 *  - a changed stylesheet swaps the live `<link rel="stylesheet">` in place;
 *  - a changed client module is re-imported (React Fast Refresh, state preserved);
 *  - a changed server component emits `rsc:update` so vinext's client dev runtime
 *    re-fetches and reconciles the route's RSC tree in place.
 * Every path keeps client component state. Runs after the preview runtime is
 * installed.
 */
const VINEXT_HMR_GLUE = `(function () {
	var runtime = window.__PREVIEW_RUNTIME__;
	if (!runtime) return;
	var STYLE_RE = new RegExp(${JSON.stringify(STYLE_EXTENSION_PATTERN)});
	// Installed before any module runs (classic script): the client build's
	// \`import.meta.hot\` resolves to this, connecting vinext's client HMR runtime
	// to the preview runtime's event bus.
	window.__vinext_client_hot__ = runtime.createHotContext('vinext-client-runtime');
	function softRefresh() {
		// Server-component change: vinext's client dev runtime listens for
		// \`rsc:update\` on \`import.meta.hot\` (wired here to this preview runtime's
		// event bus). Emitting it re-fetches the route's RSC payload and reconciles
		// the tree in place (hmrReplaceTree), preserving client component state.
		// A hard reload covers the case where that runtime is not wired.
		if (window.__vinext_client_hot__) {
			runtime.emitEvent('rsc:update', {});
			return;
		}
		location.reload();
	}
	// A stylesheet edit re-builds the same stable (non-hashed) CSS asset on the
	// server, so re-fetching each same-origin \`<link>\` with a fresh cache-busting
	// query applies the new styles without touching the DOM or React state. The
	// replacement link loads before the old one is removed to avoid a flash.
	function updateStyles() {
		var timestamp = Date.now();
		var links = document.querySelectorAll('link[rel="stylesheet"][href]');
		for (var index = 0; index < links.length; index++) {
			var link = links[index];
			var resolved;
			try {
				resolved = new URL(link.getAttribute('href'), document.baseURI);
			} catch (error) {
				continue;
			}
			if (resolved.origin !== window.location.origin) continue;
			resolved.searchParams.set('t', String(timestamp));
			var replacement = link.cloneNode(false);
			replacement.setAttribute('href', resolved.pathname + resolved.search);
			(function (oldLink) {
				replacement.addEventListener('load', function () {
					if (oldLink.parentNode) oldLink.parentNode.removeChild(oldLink);
				});
			})(link);
			link.parentNode.insertBefore(replacement, link.nextSibling);
		}
	}
	// A server-component edit reaches a non-Fast-Refresh boundary and bubbles to a
	// "reload"; route that to the state-preserving RSC refetch instead.
	window.__PREVIEW_RUNTIME_RELOAD__ = function () { softRefresh(); };
	var hot = runtime.createHotContext('/@vinext-hmr-glue');
	hot.on('vinext:hmr', function (data) {
		var path = data && data.path;
		if (!path) return;
		if (STYLE_RE.test(path)) {
			updateStyles();
			return;
		}
		// A user client module is a registered self-accepting boundary → React
		// Fast Refresh patches it in place (state preserved). A server component
		// is unregistered → the runtime bubbles to the RSC refetch above.
		var id = '/@vinext-client/' + encodeURIComponent(path);
		Promise.resolve(runtime.applyUpdate({ timestamp: Date.now(), targets: [{ id: id, kind: 'module' }] })).catch(softRefresh);
	});
})();`;

/** A built vinext app: client assets, the server isolate module set, dev context. */
interface VinextBuild {
	clientOutput: Record<string, string>;
	serverModules: Record<string, LoaderModule>;
	mainModule: string;
	devContext: DevelopmentModuleContext;
}

export class VinextPreviewHost extends DurableObject<Env> {
	/** Warm builds keyed by snapshot hash. Capped — only recent builds kept. */
	private readonly builds = new Map<string, VinextBuild>();
	/** Most recent build, reused to serve dev modules without rebuilding. */
	private latest?: VinextBuild;
	private projectId = '';
	private projectRoot = '/project';
	/** Lazily-loaded HMR script sources (`path → source`). */
	private hmrScripts?: Record<string, string>;
	/** Whether the coordinator has been told this project uses the vinext preview. */
	private coordinatorMarked = false;

	async fetch(request: Request): Promise<Response> {
		this.projectId = request.headers.get(VINEXT_PREVIEW_HEADERS.projectId) ?? this.projectId;
		this.projectRoot = request.headers.get(VINEXT_PREVIEW_HEADERS.projectRoot) ?? this.projectRoot;
		const ideOrigin = request.headers.get(VINEXT_PREVIEW_HEADERS.ideOrigin) ?? '';

		// Mark this project so the coordinator drives preview HMR through the
		// `vinext:hmr` event, letting React Fast Refresh own state preservation.
		if (!this.coordinatorMarked) {
			this.coordinatorMarked = true;
			try {
				await coordinatorNamespace.getByName(`project:${this.projectId}`).markVinextPreview();
			} catch {
				this.coordinatorMarked = false;
			}
		}

		const filesystemStub = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, this.projectId));
		return runWithProjectStub(filesystemStub, () => this.serve(request, ideOrigin), this.projectRoot);
	}

	/**
	 * Produce a production deploy build (server module set + client assets) for
	 * the project. Runs in this per-project DO so the build is single-threaded and
	 * isolated from the request-serving worker; the deploy workflow uploads the
	 * returned bundle directly (it is never persisted as workflow step state).
	 */
	async buildForDeploy(projectId: string, projectRoot: string): Promise<VinextDeployBuild> {
		this.projectId = projectId;
		this.projectRoot = projectRoot;
		const filesystemStub = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, projectId));
		return runWithProjectStub(
			filesystemStub,
			async () => {
				const snapshot = await this.collectSnapshot();
				return buildVinextForDeploy(snapshot);
			},
			projectRoot,
		);
	}

	private async serve(request: Request, ideOrigin: string): Promise<Response> {
		const url = new URL(request.url);

		if (HMR_SCRIPT_PATHS.includes(url.pathname)) {
			const scripts = await this.getHmrScripts();
			return scriptResponse(scripts[url.pathname]);
		}
		if (url.pathname === '/__vinext_hmr_glue.js') {
			return scriptResponse(VINEXT_HMR_GLUE);
		}

		try {
			// Dev module requests (HMR re-imports) must be cheap: serve the changed
			// client module from its CURRENT source against the warm build's context
			// (node_modules + React globals) — no full rebuild.
			if (isDevelopmentModuleRequest(url.pathname)) {
				const build = await this.latestOrBuild();
				const module = await serveDevelopmentModule(url.pathname, this.liveDevContext(build));
				if (module !== undefined) {
					return scriptResponse(module.code);
				}
			}

			const { build, cacheKey } = await this.buildForCurrentSnapshot();
			const server = getServerEntrypoint({
				loader: this.env.LOADER,
				cacheKey: `vinext:${cacheKey}`,
				moduleSet: {
					compatibilityDate: WORKERS_COMPATIBILITY_DATE,
					compatibilityFlags: SERVER_COMPATIBILITY_FLAGS,
					mainModule: build.mainModule,
					modules: build.serverModules,
				},
			});

			const response = await routeAppRequest(request, { clientOutput: build.clientOutput, server });
			if (response.headers.get('Content-Type')?.includes('text/html')) {
				return this.injectHmrRuntime(response, request, ideOrigin);
			}
			return response;
		} catch (error) {
			return this.serveBuildError(error, request, ideOrigin);
		}
	}

	/**
	 * Surface a build failure through the preview error overlay, matching the
	 * legacy preview pipeline. The error is broadcast so any already-open preview
	 * shows it on a failed rebuild, and the response itself renders the overlay:
	 * an HTML navigation gets a minimal document that loads the overlay script,
	 * while a script/asset request gets a module that calls into the overlay.
	 */
	private async serveBuildError(error: unknown, request: Request, ideOrigin: string): Promise<Response> {
		const serverError = toBundleServerError(error);
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
	private async injectHmrRuntime(response: Response, request: Request, ideOrigin: string): Promise<Response> {
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
			`<script src="/__vinext_hmr_glue.js"></script>`,
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
			const [refresh, overlay, runtime, hmrClient] = await Promise.all([
				import('@worker/lib/preview-scripts/react-refresh-preamble.js?raw-minified'),
				import('@worker/lib/preview-scripts/error-overlay.js?raw-minified'),
				import('@worker/lib/preview-scripts/preview-runtime.js?raw-minified'),
				import('@worker/lib/preview-scripts/hmr-client.js?raw-minified'),
			]);
			this.hmrScripts = {
				'/__vinext_react_refresh.js': refresh.source,
				'/__vinext_error_overlay.js': overlay.source,
				'/__vinext_preview_runtime.js': runtime.source,
				'/__vinext_hmr_client.js': hmrClient.source,
			};
		}
		return this.hmrScripts;
	}

	private async bootVersion(): Promise<number> {
		try {
			return await coordinatorNamespace.getByName(`project:${this.projectId}`).getUpdateVersion();
		} catch {
			return 0;
		}
	}

	/** Build (or reuse) for the current project snapshot. */
	private async buildForCurrentSnapshot(): Promise<{ build: VinextBuild; cacheKey: string }> {
		const snapshot = await this.collectSnapshot();
		const hash = await hashSnapshot(snapshot);
		const cached = this.builds.get(hash);
		if (cached !== undefined) {
			this.latest = cached;
			return { build: cached, cacheKey: `${this.projectId}:${hash}` };
		}
		const build = await this.build(snapshot);
		this.builds.set(hash, build);
		this.latest = build;
		// Keep only the two most recent builds to bound memory.
		while (this.builds.size > 2) {
			const oldest = this.builds.keys().next().value;
			if (oldest === undefined) break;
			this.builds.delete(oldest);
		}
		return { build, cacheKey: `${this.projectId}:${hash}` };
	}

	/** The latest warm build, building from the current snapshot if none exists. */
	private async latestOrBuild(): Promise<VinextBuild> {
		if (this.latest !== undefined) {
			return this.latest;
		}
		const { build } = await this.buildForCurrentSnapshot();
		return build;
	}

	/** A dev context that reads user modules from the LIVE project filesystem. */
	private liveDevContext(build: VinextBuild): DevelopmentModuleContext {
		return {
			...build.devContext,
			readSource: async (id) => {
				try {
					return await fs.readFile(`${this.projectRoot}${id}`, 'utf8');
				} catch {
					return;
				}
			},
		};
	}

	private async build(snapshot: Record<string, string>): Promise<VinextBuild> {
		const host = await ViteHost.create({
			files: snapshot,
			root: '/',
			command: 'build',
			mode: 'production',
			createPlugins: async () => {
				const { vinext } = await import('../../auxiliary/vite-host/vendor/native-plugins.mjs');
				return vinext();
			},
		});
		// Host development mode → DEV-style client references (unbundled, HMR-able).
		await runWithHostDevelopmentMode(() => host.build([...SERVER_RUNTIME_EXTERNALS], APP_ROUTER_ENTRY));

		return {
			clientOutput: host.readOutput('/dist/client'),
			serverModules: serverModulesFromOutput(host.readOutput('/dist/server')),
			mainModule: 'index.js',
			devContext: host.devModuleContext(),
		};
	}

	/**
	 * Collect the full project tree as a snapshot keyed by root-relative path
	 * (e.g. `/app/page.tsx`), excluding build output and tooling directories.
	 */
	private async collectSnapshot(): Promise<Record<string, string>> {
		const files: Record<string, string> = {};
		await this.collectInto(files, this.projectRoot, '');
		return files;
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
