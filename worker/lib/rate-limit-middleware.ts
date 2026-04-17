import { env } from 'cloudflare:workers';
import { createMiddleware } from 'hono/factory';

import { HttpErrorCode } from '@shared/http-errors';

import { httpError } from './http-error';

import type { AuthedEnvironment } from '../types';

/**
 * Middleware that enforces a per-user API rate limit.
 * Returns 429 if the user exceeds the configured request threshold.
 */
export const requireRateLimit = createMiddleware<AuthedEnvironment>(async (context, next) => {
	const { userId } = context.get('session');
	const { success } = await env.API_RATE_LIMITER.limit({ key: userId });
	if (!success) {
		throw httpError(HttpErrorCode.RATE_LIMITED, 'Too many requests. Please slow down and try again.');
	}
	await next();
});
