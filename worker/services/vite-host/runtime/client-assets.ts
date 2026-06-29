/**
 * Serve a vinext client build's static assets.
 *
 * The client environment build writes its output under `dist/client` — the
 * client entry (`index.js`), the client-reference manifest, hashed chunks under
 * `_next/static/…`, and CSS/asset files. The server-rendered HTML references
 * these at root-relative paths (e.g. `/index.js`, `/_next/static/…`). The
 * preview/runtime layer serves them directly from the build output before
 * falling back to the server isolate for SSR, mirroring how `@cloudflare/
 * vite-plugin` serves assets ahead of the worker.
 */
import { getContentType } from '@worker/lib/content-type';

/** A resolved client asset ready to serve. */
export interface ClientAsset {
	/** Output-relative file name (e.g. `index.js`). */
	fileName: string;
	contents: string;
	contentType: string;
	/** Whether the file name is content-hashed and thus immutably cacheable. */
	immutable: boolean;
}

/** Output file names that are content-hashed and safe to cache immutably. */
const IMMUTABLE_PATH_PATTERN = /(?:^|\/)(?:chunks|assets|_next\/static)\//;

/** Normalize a request pathname to a client-output key (no leading slash). */
function toOutputKey(pathname: string): string {
	const withoutQuery = pathname.split('?')[0];
	const trimmed = withoutQuery.replace(/^\/+/, '');
	return trimmed === '' ? 'index.html' : trimmed;
}

/**
 * Resolve a request path against a client build output map
 * (`outputKey -> contents`), or `undefined` when the path is not a built asset.
 */
export function resolveClientAsset(clientOutput: Record<string, string>, pathname: string): ClientAsset | undefined {
	const fileName = toOutputKey(pathname);
	const contents = clientOutput[fileName];
	if (contents === undefined) {
		return undefined;
	}
	return {
		fileName,
		contents,
		contentType: getContentType(fileName),
		immutable: IMMUTABLE_PATH_PATTERN.test(fileName),
	};
}

/** Build a `Response` for a resolved client asset with appropriate caching. */
export function clientAssetResponse(asset: ClientAsset): Response {
	return new Response(asset.contents, {
		headers: {
			'Content-Type': asset.contentType,
			'Cache-Control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
		},
	});
}
