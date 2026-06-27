/**
 * Route a request across a built vinext app.
 *
 * A vinext build produces two halves: the client environment's static assets
 * (served verbatim) and the server (rsc) isolate that performs SSR and handles
 * dynamic routes. This mirrors `@cloudflare/vite-plugin`'s production model,
 * where static assets are served ahead of the worker and the worker handles
 * everything else. The runtime serves a matching client asset when one exists,
 * otherwise it delegates to the server isolate.
 */
import { clientAssetResponse, resolveClientAsset } from './client-assets';

/** The subset of a {@link Fetcher} the router drives (a real isolate satisfies it). */
export interface ServerFetcher {
	fetch(request: Request): Promise<Response>;
}

export interface AppRuntimeSources {
	/** Client build output (`outputKey -> contents`), served as static assets. */
	clientOutput: Record<string, string>;
	/** The server (rsc) isolate entrypoint that handles SSR + dynamic routes. */
	server: ServerFetcher;
}

/**
 * Serve a built client asset when the request path maps to one, otherwise
 * delegate to the server isolate for SSR / dynamic handling.
 */
export async function routeAppRequest(request: Request, sources: AppRuntimeSources): Promise<Response> {
	const url = new URL(request.url);
	const asset = resolveClientAsset(sources.clientOutput, url.pathname);
	if (asset !== undefined) {
		return clientAssetResponse(asset);
	}
	return sources.server.fetch(request);
}
