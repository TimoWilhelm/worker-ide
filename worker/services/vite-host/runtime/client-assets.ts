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

/**
 * The vendored React/RSC runtime modules (`/__react/<env>/…`). These are IDE-
 * provided, identical across every build of a given deploy, and never change in
 * response to a user edit — only when the IDE itself ships a new React. They sit
 * at stable (non-content-hashed) URLs, so they can't be cached `immutable`
 * (that would pin an old copy across an IDE deploy), but a moderate TTL is safe
 * and removes them from the per-request DO queue on repeat loads.
 */
const RUNTIME_PATH_PATTERN = /(?:^|\/)__react\//;

/** Cache lifetime (seconds) for deploy-stable-but-unversioned assets (the vendored runtime). */
const RUNTIME_CACHE_MAX_AGE_SECONDS = 3600;

/**
 * Cache-Control for a resolved client asset. Content-hashed chunks are immutable
 * (1y); the vendored React runtime is deploy-stable so it gets a moderate TTL;
 * everything else is user build output (e.g. `index.js`, `index.css`) that
 * changes on edit and MUST revalidate every time (`no-cache`) so a preview never
 * serves stale user code.
 */
function cacheControlForAsset(asset: ClientAsset): string {
	if (asset.immutable) {
		return 'public, max-age=31536000, immutable';
	}
	if (RUNTIME_PATH_PATTERN.test(asset.fileName)) {
		return `public, max-age=${RUNTIME_CACHE_MAX_AGE_SECONDS}`;
	}
	return 'no-cache';
}

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

/**
 * A strong ETag identifying an asset's bytes within a build. The build id (the
 * snapshot hash) plus the file name uniquely determines the contents: any user
 * edit produces a new snapshot hash and thus a new ETag, so a 304 can never
 * serve stale code. `undefined` when no build id is available (e.g. tests).
 */
function assetETag(asset: ClientAsset, buildId: string | undefined): string | undefined {
	return buildId === undefined ? undefined : `"${buildId}-${asset.fileName}"`;
}

/**
 * Build a `Response` for a resolved client asset with appropriate caching. When
 * a build id is provided the response carries an ETag; a matching
 * `If-None-Match` short-circuits to a bodyless `304`, so `no-cache` assets (the
 * ~600 KB `index.js` client entry) revalidate without re-transferring on every
 * reload while still never serving stale user code.
 */
export function clientAssetResponse(asset: ClientAsset, request?: Request, buildId?: string): Response {
	const cacheControl = cacheControlForAsset(asset);
	const etag = assetETag(asset, buildId);
	if (etag !== undefined && request?.headers.get('If-None-Match') === etag) {
		return new Response(undefined, {
			status: 304,
			headers: { 'Cache-Control': cacheControl, ETag: etag },
		});
	}
	const headers: Record<string, string> = {
		'Content-Type': asset.contentType,
		'Cache-Control': cacheControl,
	};
	if (etag !== undefined) {
		headers.ETag = etag;
	}
	return new Response(asset.contents, { headers });
}
