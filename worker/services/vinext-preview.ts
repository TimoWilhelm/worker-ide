/**
 * vinext preview entry point (stateless Worker side).
 *
 * Detection is cheap and runs here; the expensive, stateful work — building the
 * app (RSC + SSR + client) and serving module-level HMR — is owned by the
 * per-project {@link VinextPreviewHost} Durable Object, which keeps the warm
 * build as instance state and reuses it deterministically across requests and
 * isolates throughout a preview/HMR session.
 */
import { fs } from '@worker/lib/project-fs';

import { vinextPreviewHostNamespace } from '../lib/durable-object-namespaces';
import { VINEXT_PREVIEW_HEADERS } from '../lib/vinext-preview-protocol';
import { isVinextProject } from './vite-host/vinext-detection';

export class VinextPreviewService {
	constructor(
		private readonly projectRoot: string,
		private readonly projectId: string,
	) {}

	/** Whether the bound project is a vinext app (cheap manifest + tree probe). */
	async isVinext(): Promise<boolean> {
		const probe = await this.collectDetectionFiles();
		return isVinextProject(probe);
	}

	/** Forward the preview request to the project's warm build Durable Object. */
	async serve(request: Request, ideOrigin: string): Promise<Response> {
		// `getByName` derives a valid id for THIS namespace (the projectId hex is
		// only a valid id for the project's primary namespace), matching how the
		// coordinator DO is addressed.
		const stub = vinextPreviewHostNamespace.getByName(`vinext:${this.projectId}`);
		const forwarded = new Request(request);
		forwarded.headers.set(VINEXT_PREVIEW_HEADERS.projectId, this.projectId);
		forwarded.headers.set(VINEXT_PREVIEW_HEADERS.projectRoot, this.projectRoot);
		forwarded.headers.set(VINEXT_PREVIEW_HEADERS.ideOrigin, ideOrigin);
		return stub.fetch(forwarded);
	}

	/** Minimal snapshot for detection: the manifest plus router-directory probes. */
	private async collectDetectionFiles(): Promise<Record<string, string>> {
		const files: Record<string, string> = {};
		try {
			files['/package.json'] = await fs.readFile(`${this.projectRoot}/package.json`, 'utf8');
		} catch {
			return files;
		}
		for (const directory of ['app', 'pages']) {
			try {
				const entries = await fs.readdir(`${this.projectRoot}/${directory}`);
				if (entries.length > 0) {
					files[`/${directory}/${entries[0]}`] = '';
				}
			} catch {
				// Directory absent — not this router.
			}
		}
		return files;
	}
}
