import { getSessionCookie } from 'better-auth/cookies';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as authSchema from '../db/auth-schema';

/**
 * Extract the raw session token from the Cookie header.
 *
 * Uses `getSessionCookie` from better-auth which handles cookie name resolution
 * and signed cookie format (`<token>.<signature>`). We strip the signature
 * since this dev helper looks up the raw token directly in D1.
 */
function getSessionToken(headers: Headers): string | undefined {
	const signed = getSessionCookie(headers);
	if (signed === undefined || signed === null) return undefined;
	const dotIndex = signed.indexOf('.');
	return dotIndex > 0 ? signed.slice(0, dotIndex) : signed;
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

	const drizzleDatabase = drizzle(database, { schema: authSchema });
	const sessions = await drizzleDatabase.select().from(authSchema.session).where(eq(authSchema.session.token, token)).limit(1);
	if (sessions.length === 0 || sessions[0].expiresAt < new Date()) return undefined;

	const users = await drizzleDatabase.select().from(authSchema.user).where(eq(authSchema.user.id, sessions[0].userId)).limit(1);
	if (users.length === 0) return undefined;

	return { session: sessions[0], user: users[0] };
}
