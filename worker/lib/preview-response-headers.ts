/**
 * Shared response-header middleware for preview responses.
 *
 * Both preview runtimes must finalize their responses identically: the static
 * (react-spa) runtime serves inline, while the durable (vinext) runtime forwards
 * to a build Durable Object. Centralising the headers here keeps the two paths
 * in parity — notably the `X-Robots-Tag` that keeps preview content out of
 * search engines, and the asset security headers that let the IDE iframe embed
 * preview assets.
 */

/** Keep preview deployments out of search indexes. */
export const PREVIEW_ROBOTS_HEADER_VALUE = 'noindex, nofollow';

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
	if (response.status === 101) return response;

	const headers = new Headers(response.headers);
	for (const middleware of middlewares) {
		middleware(headers, response, context);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
