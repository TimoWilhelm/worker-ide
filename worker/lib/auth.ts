/**
 * better-auth Instance Factory
 *
 * Creates a better-auth instance per request with the D1 binding.
 * Cloudflare Workers don't have persistent process-level state, so
 * the auth instance must be created fresh for each request with the
 * current environment bindings.
 *
 * Includes:
 * - GitHub OAuth as the sole social provider
 * - Organization plugin with default roles (owner, admin, member)
 * - Auto-creation of a personal organization on first signup
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';

import {
	INVITATION_EXPIRES_IN_SECONDS,
	MAX_MEMBERS_PER_ORGANIZATION,
	MAX_ORGANIZATIONS_PER_USER,
	MAX_PENDING_INVITATIONS_PER_ORGANIZATION,
} from '@shared/constants';

import * as schema from '../db/auth-schema';

interface AuthEnvironment {
	DB: D1Database;
	BETTER_AUTH_SECRET: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
}

export function createAuth(environment: AuthEnvironment, baseUrl: string) {
	const database = drizzle(environment.DB);

	return betterAuth({
		database: drizzleAdapter(database, {
			provider: 'sqlite',
			schema,
		}),
		baseURL: baseUrl,
		basePath: '/api/auth',
		secret: environment.BETTER_AUTH_SECRET,
		socialProviders: {
			github: {
				clientId: environment.GITHUB_CLIENT_ID,
				clientSecret: environment.GITHUB_CLIENT_SECRET,
			},
		},
		plugins: [
			organization({
				organizationLimit: MAX_ORGANIZATIONS_PER_USER,
				membershipLimit: MAX_MEMBERS_PER_ORGANIZATION,
				invitationLimit: MAX_PENDING_INVITATIONS_PER_ORGANIZATION,
				invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
			}),
		],
		user: {
			deleteUser: {
				enabled: false,
			},
		},
		session: {
			cookieCache: {
				enabled: true,
				maxAge: 5 * 60,
			},
		},
		databaseHooks: {
			user: {
				create: {
					after: async (user) => {
						// Auto-create a personal organization for every new user.
						// Uses D1 batch() for atomicity — both inserts succeed or neither does.
						try {
							const authDatabase = drizzle(environment.DB);
							const organizationId = crypto.randomUUID();
							const now = new Date();

							await authDatabase.batch([
								authDatabase.insert(schema.organization).values({
									id: organizationId,
									name: `${user.name}'s Workspace`,
									slug: `${user.id}-personal`,
									createdAt: now,
								}),
								authDatabase.insert(schema.member).values({
									id: crypto.randomUUID(),
									organizationId,
									userId: user.id,
									role: 'owner',
									createdAt: now,
								}),
							]);
						} catch (error) {
							console.error('Failed to create personal organization for user:', user.id, error);
						}
					},
				},
			},
		},
	});
}

export type Auth = ReturnType<typeof createAuth>;
