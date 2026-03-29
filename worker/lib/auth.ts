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
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
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
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
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
			google: {
				clientId: environment.GOOGLE_CLIENT_ID,
				clientSecret: environment.GOOGLE_CLIENT_SECRET,
			},
		},
		account: {
			accountLinking: {
				enabled: true,
				trustedProviders: ['google', 'github'],
			},
		},
		emailVerification: {
			sendVerificationEmail: async (data) => {
				try {
					await env.EMAIL.sendEmailVerification({
						to: data.user.email,
						userName: data.user.name,
						verificationUrl: data.url,
					});
				} catch (error) {
					console.error('Failed to send verification email:', error);
				}
			},
		},
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			sendResetPassword: async (data) => {
				try {
					await env.EMAIL.sendPasswordReset({
						to: data.user.email,
						userName: data.user.name,
						resetUrl: data.url,
					});
				} catch (error) {
					console.error('Failed to send password reset email:', error);
				}
			},
		},
		plugins: [
			organization({
				organizationLimit: MAX_ORGANIZATIONS_PER_USER,
				membershipLimit: MAX_MEMBERS_PER_ORGANIZATION,
				invitationLimit: MAX_PENDING_INVITATIONS_PER_ORGANIZATION,
				invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
				sendInvitationEmail: async (data) => {
					const acceptUrl = `${baseUrl}/api/auth/organization/accept-invitation?id=${data.id}`;
					try {
						await env.EMAIL.sendOrgInvitation({
							to: data.email,
							inviterName: data.inviter.user.name,
							organizationName: data.organization.name,
							role: data.role,
							acceptUrl,
						});
					} catch (error) {
						console.error('Failed to send invitation email:', error);
					}
				},
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
						// Retries up to 3 times to handle rare slug uniqueness collisions.
						const authDatabase = drizzle(environment.DB);
						const baseSlug =
							user.name
								.toLowerCase()
								.replaceAll(/[^\da-z]+/g, '-')
								.replaceAll(/^-|-$/g, '') || 'workspace';

						let lastError: unknown;
						for (let attempt = 0; attempt < 3; attempt++) {
							try {
								const organizationId = crypto.randomUUID();
								const now = new Date();
								const orgSlug = `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;

								await authDatabase.batch([
									authDatabase.insert(schema.organization).values({
										id: organizationId,
										name: `${user.name}'s Workspace`,
										slug: orgSlug,
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
								break;
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								if (!message.includes('UNIQUE constraint failed')) {
									console.error('Failed to create personal organization for user:', user.id, error);
									break;
								}
								lastError = error;
							}
						}
						if (lastError) {
							console.error('Failed to create personal organization for user after retries:', user.id, lastError);
						}
					},
				},
			},
			session: {
				create: {
					before: async (session) => {
						// Check ban/soft-delete status before allowing a new session (sign-in).
						// - Banned users are rejected (return false).
						// - Soft-deleted users are restored (clear deleted_at) and allowed in.
						try {
							const authDatabase = drizzle(environment.DB);
							const userRows = await authDatabase
								.select({ bannedAt: schema.user.bannedAt, deletedAt: schema.user.deletedAt })
								.from(schema.user)
								.where(eq(schema.user.id, session.userId))
								.limit(1);

							if (userRows.length === 0) return;

							const userRow = userRows[0];

							// Banned users cannot sign in
							if (userRow.bannedAt) {
								return false;
							}

							// Soft-deleted users are restored on sign-in
							if (userRow.deletedAt) {
								await authDatabase
									.update(schema.user)
									// eslint-disable-next-line unicorn/no-null -- Drizzle ORM requires null to clear nullable columns
									.set({ deletedAt: null, updatedAt: new Date() })
									.where(eq(schema.user.id, session.userId));
							}
						} catch (error) {
							console.error('Failed to check user ban/delete status during session creation:', error);
						}
					},
				},
			},
		},
		advanced: {
			ipAddress: {
				ipAddressHeaders: ['cf-connecting-ip'],
			},
		},
	});
}

export type Auth = ReturnType<typeof createAuth>;
