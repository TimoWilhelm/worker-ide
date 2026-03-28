/**
 * Dev-only session resolution helpers.
 *
 * Shared between `worker/index.ts` (dev auth route stubs) and
 * `worker/lib/auth-middleware.ts` (dev fast-path) to avoid duplicating
 * the cookie-parsing and D1 session lookup logic.
 *
 * All code in this module is guarded by `import.meta.env.DEV` at the
 * call-site and is dead-code-eliminated from production builds.
 */

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as authSchema from '../db/auth-schema';

/**
 * Extract the `better-auth.session_token` value from the Cookie header.
 */
function getSessionToken(headers: Headers): string | undefined {
	const cookie = headers.get('Cookie');
	if (!cookie) return undefined;
	const match = cookie.match(/better-auth\.session_token=([^;]+)/);
	return match?.[1];
}

/**
 * Resolve the session row + user from the session cookie via D1.
 * Returns undefined if no valid session exists or the session is expired.
 */
export async function resolveDevelopmentSession(
	database: D1Database,
	headers: Headers,
): Promise<{ session: typeof authSchema.session.$inferSelect; user: typeof authSchema.user.$inferSelect } | undefined> {
	const token = getSessionToken(headers);
	if (!token) return undefined;

	const drizzleDatabase = drizzle(database);
	const sessions = await drizzleDatabase.select().from(authSchema.session).where(eq(authSchema.session.token, token)).limit(1);
	if (sessions.length === 0 || sessions[0].expiresAt < new Date()) return undefined;

	const users = await drizzleDatabase.select().from(authSchema.user).where(eq(authSchema.user.id, sessions[0].userId)).limit(1);
	if (users.length === 0) return undefined;

	return { session: sessions[0], user: users[0] };
}
