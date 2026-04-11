/**
 * Hono middleware that tracks API request timing and status via Analytics Engine.
 *
 * Records the route pattern, HTTP method, response status, and duration for
 * every API request. Mount on API routes and project-scoped API routes.
 */

import { createMiddleware } from 'hono/factory';

import { trackApiRequest } from './analytics';

import type { AuthedEnvironment } from '../types';

/** Unauthenticated route prefixes/paths that should not be tracked. */
const SKIP_PREFIXES = ['/api/auth/', '/api/health', '/api/templates', '/api/version'];

/**
 * Analytics timing middleware.
 * Must be mounted AFTER auth middleware so `userId` is available on context.
 * Skips unauthenticated routes (health, auth, templates, version) to keep
 * the dataset focused on meaningful, authenticated API traffic.
 */
export const analyticsMiddleware = createMiddleware<AuthedEnvironment>(async (context, next) => {
	const pathname = new URL(context.req.url).pathname;
	if (SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
		await next();
		return;
	}

	const start = Date.now();

	await next();

	const durationMs = Date.now() - start;

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
		statusCode: context.res.status,
		durationMs,
		request: context.req.raw,
	});
});
