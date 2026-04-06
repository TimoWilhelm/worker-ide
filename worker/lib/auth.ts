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

import { betterAuth, APIError } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, organization } from 'better-auth/plugins';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { INVITATION_EXPIRES_IN_SECONDS } from '@shared/constants';
import { resolveOrgLimitsFromRows, resolveUserLimitsFromRows } from '@shared/entitlements';

import { queryEntitlements } from './entitlements';
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
				trustedProviders: [],
				allowDifferentEmails: true,
			},
		},
		onAPIError: {
			errorURL: '/',
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
			// Include admin plugin fields in the synthetic user response so
			// fake sign-up responses are indistinguishable from real ones
			// (email enumeration protection).
			customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
				...coreFields,
				role: 'user',

				banned: false,
				// eslint-disable-next-line unicorn/no-null -- better-auth expects null for these fields
				banReason: null,
				// eslint-disable-next-line unicorn/no-null -- better-auth expects null for these fields
				banExpires: null,
				...additionalFields,
				id,
			}),
		},
		plugins: [
			admin({
				defaultRole: 'user',
				bannedUserMessage: 'CONTACT_SUPPORT',
			}),
			organization({
				// Dynamic org-creation limit: checks user entitlements
				organizationLimit: async (user) => {
					const entitlementDatabase = drizzle(environment.DB);
					const rows = await queryEntitlements(entitlementDatabase, user.id);
					const { maxOrganizations } = resolveUserLimitsFromRows(rows);

					const userOrganizations = await entitlementDatabase
						.select({ id: schema.member.organizationId })
						.from(schema.member)
						.where(eq(schema.member.userId, user.id));

					return userOrganizations.length >= maxOrganizations;
				},

				// Dynamic membership limit: plan-based + org entitlements
				membershipLimit: async (_user, organizationRecord) => {
					const entitlementDatabase = drizzle(environment.DB);
					const [entitlementRows, organizationRows] = await Promise.all([
						queryEntitlements(entitlementDatabase, organizationRecord.id),
						entitlementDatabase
							.select({ plan: schema.organization.plan })
							.from(schema.organization)
							.where(eq(schema.organization.id, organizationRecord.id))
							.limit(1),
					]);
					const plan = organizationRows[0]?.plan ?? 'free';
					const { maxMembers } = resolveOrgLimitsFromRows(plan, entitlementRows);
					return maxMembers;
				},

				// Dynamic invitation limit: shares the member limit (invitations are pre-members)
				invitationLimit: async ({ organization: organizationRecord }) => {
					const entitlementDatabase = drizzle(environment.DB);
					const [entitlementRows, organizationRows] = await Promise.all([
						queryEntitlements(entitlementDatabase, organizationRecord.id),
						entitlementDatabase
							.select({ plan: schema.organization.plan })
							.from(schema.organization)
							.where(eq(schema.organization.id, organizationRecord.id))
							.limit(1),
					]);
					const plan = organizationRows[0]?.plan ?? 'free';
					const { maxMembers } = resolveOrgLimitsFromRows(plan, entitlementRows);
					return maxMembers;
				},

				schema: {
					organization: {
						additionalFields: {
							plan: {
								type: 'string',
								defaultValue: 'free',
								required: false,
								input: false,
							},
							deletedAt: {
								type: 'date',
								required: false,
								input: false,
							},
							bannedAt: {
								type: 'date',
								required: false,
								input: false,
							},
						},
					},
				},

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
			organization: {
				update: {
					before: async (organizationData: { id?: string } & Record<string, unknown>) => {
						// Block updates to banned organizations.
						// better-auth's organization.update() passes the full org with id.
						if (!organizationData.id) return; // Can't check without an ID
						const organizationId = organizationData.id;
						try {
							const authDatabase = drizzle(environment.DB);
							const orgRows = await authDatabase
								.select({ bannedAt: schema.organization.bannedAt })
								.from(schema.organization)
								.where(eq(schema.organization.id, organizationId))
								.limit(1);

							if (orgRows.length > 0 && orgRows[0].bannedAt) {
								throw new APIError('FORBIDDEN', { message: 'CONTACT_SUPPORT' });
							}
						} catch (error) {
							// Re-throw APIError; swallow unexpected DB errors to avoid
							// breaking the auth flow. This is a deliberate fail-open trade-off:
							// a transient D1 error allows the update rather than blocking
							// all org updates. The ban is still enforced at the route level.
							if (error instanceof APIError) throw error;
							console.error('Failed to check org ban status during organization update:', error);
						}
					},
				},
			},
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
						// Soft-deleted users are restored on sign-in.
						try {
							const authDatabase = drizzle(environment.DB);
							const userRows = await authDatabase
								.select({ deletedAt: schema.user.deletedAt })
								.from(schema.user)
								.where(eq(schema.user.id, session.userId))
								.limit(1);

							if (userRows.length === 0) return;

							if (userRows[0].deletedAt) {
								await authDatabase
									.update(schema.user)
									// eslint-disable-next-line unicorn/no-null -- Drizzle ORM requires null to clear nullable columns
									.set({ deletedAt: null, updatedAt: new Date() })
									.where(eq(schema.user.id, session.userId));
							}
						} catch (error) {
							console.error('Failed to check user status during session creation:', error);
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
