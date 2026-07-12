/**
 * Shared response-header middleware for preview responses.
 *
 * Both preview runtimes must finalize their responses identically: the static
 * (react-spa) runtime serves inline, while the artifact (vinext) runtime uses a
 * cache-backed build entrypoint. Centralising the headers here keeps the two paths
 * in parity — notably the `X-Robots-Tag` that keeps preview content out of
 * search engines, and the asset security headers that let the IDE iframe embed
 * preview assets.
 */

/** Keep preview deployments out of search indexes. */
export const PREVIEW_ROBOTS_HEADER_VALUE = 'noindex, nofollow';

/**
 * Response headers a previewed app must never be allowed to set on the shared
 * preview domain. Generated apps are untrusted: their responses flow straight
 * back to the browser, so any header that grants authority over the origin (or
 * the wider registrable domain the preview subdomains share) is stripped before
 * the response leaves the worker.
 *
 * - `Service-Worker-Allowed` lets a service worker widen its scope (e.g. to
 *   `/`), so a malicious app could register a SW that intercepts requests for
 *   other paths/previews served from the same origin.
 * - `Service-Worker-Navigation-Preload` is part of the same SW attack surface.
 * - `Clear-Site-Data` can wipe cookies, storage and caches for the preview
 *   domain, letting one app clear another user's preview session/state.
 */
export const STRIPPED_PREVIEW_HEADERS = ['Service-Worker-Allowed', 'Service-Worker-Navigation-Preload', 'Clear-Site-Data'] as const;

export interface PreviewResponseContext {
	ideOrigin: string;
}

export type PreviewResponseMiddleware = (headers: Headers, response: Response, context: PreviewResponseContext) => void;

/**
 * Headers that make preview assets safely embeddable in the IDE iframe while
 * limiting cross-origin exposure. Applied to non-HTML responses only.
 */
function buildAssetSecurityHeaders(ideOrigin: string): Record<string, string> {
	return {
		'Cross-Origin-Resource-Policy': 'same-site',
		'Content-Security-Policy': `frame-ancestors ${ideOrigin}`,
		'Referrer-Policy': 'no-referrer',
	};
}

export function applyAssetSecurityHeaders(headers: Headers, response: Response, context: PreviewResponseContext): void {
	if (response.headers.get('Content-Type')?.includes('text/html')) return;

	for (const [name, value] of Object.entries(buildAssetSecurityHeaders(context.ideOrigin))) {
		headers.set(name, value);
	}
}

export function applyPreviewRobotsHeader(headers: Headers): void {
	headers.set('X-Robots-Tag', PREVIEW_ROBOTS_HEADER_VALUE);
}

/** The default middleware chain applied to every preview response. */
export const previewResponseMiddlewares: PreviewResponseMiddleware[] = [applyAssetSecurityHeaders, applyPreviewRobotsHeader];

/** Apply `middlewares` to a copy of `response`'s headers (WebSocket upgrades pass through). */
export function applyPreviewResponseMiddlewares(
	response: Response,
	context: PreviewResponseContext,
	middlewares: PreviewResponseMiddleware[],
): Response {
	// WebSocket upgrade responses cannot be reconstructed (no body, immutable
	// headers) and never carry the stripped headers, so pass them through as-is.
	if (response.status === 101 || response.headers.get('Upgrade')?.toLowerCase() === 'websocket') return response;

	const headers = new Headers(response.headers);

	// Strip headers a previewed app must not be able to set on the shared preview
	// origin before running any other middleware.
	for (const name of STRIPPED_PREVIEW_HEADERS) {
		headers.delete(name);
	}

	for (const middleware of middlewares) {
		middleware(headers, response, context);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
