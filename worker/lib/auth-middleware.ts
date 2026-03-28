/**
 * Auth Middleware
 *
 * Hono middleware that validates the session cookie on protected routes.
 * Sets userId, session, and activeOrganizationId on the Hono context
 * so downstream route handlers can access the authenticated user.
 *
 * Uses better-auth's `api.getSession()` to validate the cookie.
 *
 * On localhost (dev/e2e), an alternative fast path validates a test
 * session token directly against D1 to avoid the miniflare loopback
 * fetch issue where `auth.api.getSession()` crashes because miniflare
 * cannot dispatch internal HTTP requests back to itself.
 */

import { createMiddleware } from 'hono/factory';

import { buildAppOrigin, parseHost } from '@shared/domain';

import { createAuth } from './auth';

import type { AuthedEnvironment } from '../types';

/**
 * Middleware that requires a valid session. Returns 401 if not authenticated.
 */
export const requireAuth = createMiddleware<AuthedEnvironment>(async (context, next) => {
	const url = new URL(context.req.url);

	// ---------------------------------------------------------------------------
	// Dev-only fast path: validate the session token directly via D1.
	// This avoids better-auth's internal loopback HTTP call which crashes
	// in the miniflare/Vite dev environment.
	// Dead-code-eliminated from production builds by Vite.
	// ---------------------------------------------------------------------------
	if (import.meta.env.DEV) {
		const { resolveDevelopmentSession } = await import('./development-session');
		const result = await resolveDevelopmentSession(context.env.DB, context.req.raw.headers);
		if (!result) {
			return context.json({ error: 'Unauthorized' }, 401);
		}

		context.set('userId', result.session.userId);
		context.set('userSession', { id: result.session.id, activeOrganizationId: result.session.activeOrganizationId });
		context.set('activeOrganizationId', result.session.activeOrganizationId ?? undefined);
		await next();
		return;
	}

	// ---------------------------------------------------------------------------
	// Production path: use better-auth's full session validation.
	// ---------------------------------------------------------------------------
	const baseUrl = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);

	const auth = createAuth(
		{
			DB: context.env.DB,
			BETTER_AUTH_SECRET: context.env.BETTER_AUTH_SECRET,
			GITHUB_CLIENT_ID: context.env.GITHUB_CLIENT_ID,
			GITHUB_CLIENT_SECRET: context.env.GITHUB_CLIENT_SECRET,
		},
		baseUrl,
	);

	const session = await auth.api.getSession({ headers: context.req.raw.headers });

	if (!session) {
		return context.json({ error: 'Unauthorized' }, 401);
	}

	context.set('userId', session.user.id);
	context.set('userSession', session.session);
	context.set('activeOrganizationId', session.session.activeOrganizationId ?? undefined);

	await next();
});
