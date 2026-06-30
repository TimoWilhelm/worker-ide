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
import { applyPreviewResponseMiddlewares, previewResponseMiddlewares } from '../lib/preview-response-headers';
import { VINEXT_PREVIEW_HEADERS } from '../lib/vinext-preview-protocol';
import { selectRuntime } from './vite-host/runtimes/registry';

import type { ResolvedAssetSettings } from '@shared/types';

export class PreviewService {
	constructor(
		private readonly projectRoot: string,
		private readonly projectId: string,
	) {}

	/** Asset settings from the project's `wrangler.jsonc` (defaults when absent). */
	async loadAssetSettings(): Promise<ResolvedAssetSettings> {
		try {
			const raw = await fs.readFile(`${this.projectRoot}/wrangler.jsonc`, 'utf8');
			const wrangler: { assets?: Record<string, unknown> } = parseJsonc(raw);
			return resolveAssetSettings(wrangler.assets);
		} catch {
			return resolveAssetSettings();
		}
	}

	/** Resolve the project's runtime and serve (or forward) the preview request. */
	async routePreviewRequest(request: Request, ideOrigin: string, preloadedAssetSettings?: ResolvedAssetSettings): Promise<Response> {
		const probe = await this.collectDetectionFiles();
		const runtime = selectRuntime({ files: probe });

		if (runtime.hosting === 'durable') {
			return this.forwardToDurableHost(request, ideOrigin, runtime.id);
		}

		const assetSettings = preloadedAssetSettings ?? (await this.loadAssetSettings());
		return runtime.serve(request, {
			projectRoot: this.projectRoot,
			projectId: this.projectId,
			ideOrigin,
			assetSettings,
		});
	}

	/** Forward a preview request to the project's warm build Durable Object. */
	private async forwardToDurableHost(request: Request, ideOrigin: string, runtimeId: string): Promise<Response> {
		// `getByName` derives a valid id for THIS namespace (the projectId hex is
		// only a valid id for the project's primary namespace).
		const stub = vinextPreviewHostNamespace.getByName(`vinext:${this.projectId}`);
		const forwarded = new Request(request);
		forwarded.headers.set(VINEXT_PREVIEW_HEADERS.projectId, this.projectId);
		forwarded.headers.set(VINEXT_PREVIEW_HEADERS.projectRoot, this.projectRoot);
		forwarded.headers.set(VINEXT_PREVIEW_HEADERS.ideOrigin, ideOrigin);
		forwarded.headers.set(VINEXT_PREVIEW_HEADERS.runtimeId, runtimeId);
		const response = await stub.fetch(forwarded);
		// Finalize with the same headers the stateless runtime applies (robots +
		// asset security), so preview parity holds across both hosting modes.
		return applyPreviewResponseMiddlewares(response, { ideOrigin }, previewResponseMiddlewares);
	}

	/** Minimal snapshot for runtime detection: the manifest plus entry/router probes. */
	private async collectDetectionFiles(): Promise<Record<string, string>> {
		const files: Record<string, string> = {};
		try {
			files['/package.json'] = await fs.readFile(`${this.projectRoot}/package.json`, 'utf8');
		} catch {
			return files;
		}
		try {
			files['/index.html'] = await fs.readFile(`${this.projectRoot}/index.html`, 'utf8');
		} catch {
			// No index.html — not an SPA entry.
		}
		for (const directory of ['app', 'pages', 'src']) {
			try {
				const entries = await fs.readdir(`${this.projectRoot}/${directory}`);
				if (entries.length > 0) {
					files[`/${directory}/${entries[0]}`] = '';
				}
			} catch {
				// Directory absent.
			}
		}
		return files;
	}
}
