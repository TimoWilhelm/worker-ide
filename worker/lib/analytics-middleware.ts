/**
 * Hono middleware that tracks API request timing and status via Analytics Engine.
 *
 * Records the route pattern, HTTP method, response status, and duration for
 * every API request. Mount on API routes and project-scoped API routes.
 */

import { createMiddleware } from 'hono/factory';

import { trackApiRequest } from './analytics';

import type { AuthedEnvironment } from '../types';

function getProjectIdFromPathname(pathname: string): string | undefined {
	const match = pathname.match(/^\/p\/([^/]+)\/api\//);
	if (!match) {
		return undefined;
	}
	return match[1];
}

/**
 * Analytics timing middleware.
 * Must be mounted after auth middleware on protected routes so `session`
 * is available on context and unauthenticated requests are never tracked.
 */
export const analyticsMiddleware = createMiddleware<AuthedEnvironment>(async (context, next) => {
	const pathname = new URL(context.req.url).pathname;
	const start = Date.now();

	await next();

	const durationMs = Date.now() - start;
	const projectId = getProjectIdFromPathname(pathname);

	let userId = '';
	try {
		userId = context.get('session').userId ?? '';
	} catch {
		// userId not set — should not happen for authenticated routes
	}

	trackApiRequest({
		userId,
		route: pathname,
		method: context.req.method,
		projectId,
		statusCode: context.res.status,
		durationMs,
		request: context.req.raw,
	});
});
