/**
 * Preview entry point (stateless worker side) — a thin runtime dispatcher.
 *
 * Every project resolves to a {@link FrameworkRuntime} via the registry (keyed on
 * a cheap package.json + tree probe). There is no special-cased legacy path:
 *  - a `durable` runtime (vinext, …) forwards to its per-project build Durable
 *    Object, which owns the warm build + module-level HMR;
 *  - a `stateless` runtime (the static React SPA + worker) serves the request
 *    inline.
 * The public API (`loadAssetSettings`, `routePreviewRequest`) is unchanged, so
 * `worker/index.ts` and the agent preview tool keep working without changes.
 */
import { parseJsonc } from '@shared/jsonc';
import { resolveAssetSettings } from '@shared/types';
import { fs } from '@worker/lib/project-fs';

import { vinextPreviewHostNamespace } from '../lib/durable-object-namespaces';
import { buildDetectionProbe } from '../lib/preview-bootstrap';
import { stripPreviewRequestCredentials } from '../lib/preview-request-headers';
import { applyPreviewResponseMiddlewares, previewResponseMiddlewares } from '../lib/preview-response-headers';
import { withSpan } from '../lib/tracing';
import { VINEXT_PREVIEW_HEADERS } from '../lib/vinext-preview-protocol';
import { selectRuntime } from './vite-host/runtimes/registry';

import type { PreviewBootstrap } from '../lib/preview-bootstrap';
import type { FrameworkRuntime } from './vite-host/runtimes/types';
import type { ResolvedAssetSettings } from '@shared/types';

/**
 * How long a resolved runtime selection is reused before re-probing the project
 * tree. Runtime detection reads `package.json` + `index.html` + several
 * `readdir`s over cross-DO fs RPC on every call (~hundreds of ms). A short TTL
 * collapses the burst of asset subrequests behind one page load into a single
 * probe while still re-detecting quickly after a framework change (which is rare
 * and independently triggers a full preview reload).
 */
const RUNTIME_DETECTION_TTL_MS = 5000;

export class PreviewService {
	/** Memoized runtime selection (short TTL); avoids re-probing on every asset request. */
	private cachedRuntime?: { runtime: FrameworkRuntime; expiresAt: number };
	/** Memoized asset settings (short TTL); same rationale as {@link cachedRuntime}. */
	private cachedAssetSettings?: { value: ResolvedAssetSettings; expiresAt: number };

	constructor(
		private readonly projectRoot: string,
		private readonly projectId: string,
	) {}

	/**
	 * Seed the runtime + asset-settings memos from a single preview bootstrap
	 * snapshot (see {@link PreviewBootstrap}), so the burst of subrequests behind
	 * a page load serve without any further cross-DO reads. The `PreviewService`
	 * instance is cached per project; seeding with a fresh snapshot is strictly
	 * better than letting the memos lazily re-read the tree.
	 */
	applyBootstrap(bootstrap: PreviewBootstrap): void {
		const expiresAt = Date.now() + RUNTIME_DETECTION_TTL_MS;
		this.cachedRuntime = { runtime: selectRuntime(buildDetectionProbe(bootstrap)), expiresAt };
		this.cachedAssetSettings = { value: resolveWranglerAssetSettings(bootstrap.wranglerJsonc), expiresAt };
	}

	/** Asset settings from the project's `wrangler.jsonc` (defaults when absent). */
	async loadAssetSettings(): Promise<ResolvedAssetSettings> {
		const now = Date.now();
		if (this.cachedAssetSettings !== undefined && this.cachedAssetSettings.expiresAt > now) {
			return this.cachedAssetSettings.value;
		}
		let raw: string | undefined;
		try {
			raw = await fs.readFile(`${this.projectRoot}/wrangler.jsonc`, 'utf8');
		} catch {
			raw = undefined;
		}
		const value = resolveWranglerAssetSettings(raw);
		this.cachedAssetSettings = { value, expiresAt: now + RUNTIME_DETECTION_TTL_MS };
		return value;
	}

	/** Resolve the project's runtime and serve (or forward) the preview request. */
	async routePreviewRequest(
		request: Request,
		ideOrigin: string,
		preloadedAssetSettings?: ResolvedAssetSettings,
		snapshotHash?: string,
	): Promise<Response> {
		return withSpan(
			'preview.route',
			async (span) => {
				const runtime = await this.resolveRuntime();
				span.setAttribute('runtime.id', runtime.id);
				span.setAttribute('runtime.hosting', runtime.hosting);

				if (runtime.hosting === 'durable') {
					return this.forwardToDurableHost(request, ideOrigin, runtime.id, snapshotHash);
				}

				const assetSettings = preloadedAssetSettings ?? (await this.loadAssetSettings());
				return runtime.serve(request, {
					projectRoot: this.projectRoot,
					projectId: this.projectId,
					ideOrigin,
					assetSettings,
				});
			},
			{ 'project.id': this.projectId, 'request.path': new URL(request.url).pathname },
		);
	}

	/** Forward a preview request to the project's warm build Durable Object. */
	private forwardToDurableHost(request: Request, ideOrigin: string, runtimeId: string, snapshotHash?: string): Promise<Response> {
		return withSpan(
			'preview.forward',
			async () => {
				// `getByName` derives a valid id for THIS namespace (the projectId hex is
				// only a valid id for the project's primary namespace).
				const stub = vinextPreviewHostNamespace.getByName(`vinext:${this.projectId}`);
				const forwarded = new Request(request);
				// The vinext server isolate runs untrusted generated code. Strip the
				// browser's credentials (notably the private-preview access cookie) so
				// the app cannot read and exfiltrate them; access was already validated
				// upstream. Mirrors the React-SPA path (see `static-preview.ts`).
				stripPreviewRequestCredentials(forwarded.headers);
				forwarded.headers.set(VINEXT_PREVIEW_HEADERS.projectId, this.projectId);
				forwarded.headers.set(VINEXT_PREVIEW_HEADERS.projectRoot, this.projectRoot);
				forwarded.headers.set(VINEXT_PREVIEW_HEADERS.ideOrigin, ideOrigin);
				forwarded.headers.set(VINEXT_PREVIEW_HEADERS.runtimeId, runtimeId);
				if (snapshotHash !== undefined) {
					forwarded.headers.set(VINEXT_PREVIEW_HEADERS.snapshotHash, snapshotHash);
				}
				const response = await stub.fetch(forwarded);
				// Finalize with the same headers the stateless runtime applies (robots +
				// asset security), so preview parity holds across both hosting modes.
				return applyPreviewResponseMiddlewares(response, { ideOrigin }, previewResponseMiddlewares);
			},
			{ 'runtime.id': runtimeId },
		);
	}

	/**
	 * Resolve the project's runtime, memoized for {@link RUNTIME_DETECTION_TTL_MS}.
	 * The `PreviewService` instance is cached per project, so this reuses the
	 * detection across the burst of subrequests behind a page load instead of
	 * re-probing the tree on every asset request.
	 */
	private async resolveRuntime(): Promise<FrameworkRuntime> {
		const now = Date.now();
		if (this.cachedRuntime !== undefined && this.cachedRuntime.expiresAt > now) {
			return this.cachedRuntime.runtime;
		}
		const probe = await withSpan('preview.detect', () => this.collectDetectionFiles());
		const runtime = selectRuntime({ files: probe });
		this.cachedRuntime = { runtime, expiresAt: now + RUNTIME_DETECTION_TTL_MS };
		return runtime;
	}

	/**
	 * Minimal snapshot for runtime detection: the manifest plus entry/router probes.
	 *
	 * Every read here is a cross-Durable-Object round trip to the filesystem DO
	 * (~hundreds of ms of pure latency each), so they are issued CONCURRENTLY and
	 * awaited once via `Promise.all` rather than sequentially. Sequential awaits
	 * turned a ~150ms-of-work probe into ~5 serial round trips (~700ms+); batching
	 * collapses that to a single round-trip's latency. Semantics are unchanged: a
	 * missing `package.json` means "not detectable" (empty result), `index.html`
	 * is optional, and each router directory contributes its first entry.
	 */
	private async collectDetectionFiles(): Promise<Record<string, string>> {
		const routerDirectories = ['app', 'pages', 'src'];
		const [packageJson, indexHtml, ...directoryEntries] = await Promise.all([
			fs.readFile(`${this.projectRoot}/package.json`, 'utf8').catch(() => {}),
			fs.readFile(`${this.projectRoot}/index.html`, 'utf8').catch(() => {}),
			...routerDirectories.map((directory) => fs.readdir(`${this.projectRoot}/${directory}`).catch(() => [])),
		]);

		const files: Record<string, string> = {};
		if (packageJson === undefined) {
			// No manifest — nothing to detect against.
			return files;
		}
		files['/package.json'] = packageJson;
		if (indexHtml !== undefined) {
			files['/index.html'] = indexHtml;
		}
		for (const [index, directory] of routerDirectories.entries()) {
			const entries = directoryEntries[index];
			if (entries.length > 0) {
				files[`/${directory}/${entries[0]}`] = '';
			}
		}
		return files;
	}
}

/** Resolve asset settings from raw `wrangler.jsonc` contents (defaults when absent/invalid). */
function resolveWranglerAssetSettings(rawWranglerJsonc: string | undefined): ResolvedAssetSettings {
	if (rawWranglerJsonc === undefined) {
		return resolveAssetSettings();
	}
	try {
		const wrangler: { assets?: Record<string, unknown> } = parseJsonc(rawWranglerJsonc);
		return resolveAssetSettings(wrangler.assets);
	} catch {
		return resolveAssetSettings();
	}
}
