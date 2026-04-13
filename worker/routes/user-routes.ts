/**
 * User-scoped routes.
 *
 * Handles per-user operations that are not scoped to a specific organization:
 * - Recently accessed projects (cross-org)
 * - Project favorites
 * - Account deletion preview and execution
 */

import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { resolveUserPreferences } from '@shared/constants';
import { resolveUserLimitsFromRows } from '@shared/entitlements';
import { HttpErrorCode } from '@shared/http-errors';
import {
	favoriteBodySchema,
	pushNotificationPreferenceBodySchema,
	pushSubscriptionBodySchema,
	pushUnsubscribeBodySchema,
	userPreferencesBodySchema,
} from '@shared/validation';

import * as schema from '../db/auth-schema';
import { trackAuthEvent } from '../lib/analytics';
import { queryEntitlements } from '../lib/entitlements';
import { httpError } from '../lib/http-error';

import type { AuthedEnvironment } from '../types';

const MAX_RECENT_PROJECTS = 20;

export const userRoutes = new Hono<AuthedEnvironment>()
	// GET /api/user/limits — Resolved limits + current usage for the authenticated user
	.get('/user/limits', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB);

		const [entitlementRows, orgCountRows] = await Promise.all([
			queryEntitlements(database, userId),
			database.select({ count: count() }).from(schema.member).where(eq(schema.member.userId, userId)),
		]);

		const limits = resolveUserLimitsFromRows(entitlementRows);

		return c.json({
			maxOrganizations: limits.maxOrganizations,
			currentOrganizations: orgCountRows[0]?.count ?? 0,
		});
	})

	// GET /api/user/recent-projects — Recently accessed projects across all orgs
	.get('/user/recent-projects', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB);

		// Get all orgs the user belongs to
		const memberships = await database
			.select({ organizationId: schema.member.organizationId })
			.from(schema.member)
			.where(eq(schema.member.userId, userId));

		const organizationIds = memberships.map((m) => m.organizationId);
		if (organizationIds.length === 0) {
			return c.json({ projects: [] });
		}

		// Get user's project access records
		const accessRecords = await database
			.select()
			.from(schema.userProjectAccess)
			.where(eq(schema.userProjectAccess.userId, userId))
			.orderBy(desc(schema.userProjectAccess.lastAccessedAt))
			.limit(MAX_RECENT_PROJECTS);

		if (accessRecords.length === 0) {
			return c.json({ projects: [] });
		}

		const projectIds = accessRecords.map((record) => record.projectId);
		const favoriteRecords = await database
			.select({ projectId: schema.userProjectFavorite.projectId })
			.from(schema.userProjectFavorite)
			.where(and(eq(schema.userProjectFavorite.userId, userId), inArray(schema.userProjectFavorite.projectId, projectIds)));

		// Get project details for accessed projects (only non-deleted, non-banned ones in user's non-banned orgs)
		const projects = await database
			.select({
				id: schema.project.id,
				organizationId: schema.project.organizationId,
				name: schema.project.name,
				previewVisibility: schema.project.previewVisibility,
				createdByUserId: schema.project.createdByUserId,
				createdAt: schema.project.createdAt,
				updatedAt: schema.project.updatedAt,
			})
			.from(schema.project)
			.leftJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
			.where(
				and(
					inArray(schema.project.id, projectIds),
					inArray(schema.project.organizationId, organizationIds),
					isNull(schema.project.deletedAt),
					isNull(schema.project.bannedAt),
					isNull(schema.organization.bannedAt),
				),
			);

		// Get org names for labeling
		const orgIds = [...new Set(projects.map((p) => p.organizationId))];
		const organizations =
			orgIds.length > 0
				? await database
						.select({ id: schema.organization.id, name: schema.organization.name, slug: schema.organization.slug })
						.from(schema.organization)
						.where(inArray(schema.organization.id, orgIds))
				: [];
		const organizationMap = new Map(organizations.map((o) => [o.id, o]));

		// Merge access info with project details
		const accessMap = new Map(accessRecords.map((record) => [record.projectId, record]));
		const favoriteProjectIds = new Set(favoriteRecords.map((record) => record.projectId));
		const projectsWithAccess = projects
			.map((project) => {
				const access = accessMap.get(project.id);
				const organization = organizationMap.get(project.organizationId);
				return {
					...project,
					lastAccessedAt: access?.lastAccessedAt.toISOString() ?? project.updatedAt.toISOString(),
					isFavorite: favoriteProjectIds.has(project.id),
					organizationName: organization?.name ?? 'Unknown',
					organizationSlug: organization?.slug ?? '',
				};
			})
			.toSorted((a, b) => {
				// Favorites first, then by last accessed
				if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
				return new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime();
			});

		return c.json({ projects: projectsWithAccess });
	})

	// PUT /api/user/project/:projectId/favorite — Set favorite status
	.put('/user/project/:projectId/favorite', zValidator('json', favoriteBodySchema), async (c) => {
		const { userId } = c.get('session');
		const { projectId } = c.req.param();
		const database = drizzle(c.env.DB);

		const body = c.req.valid('json');

		// Verify user is a member of the project's organization
		const projectMember = await database
			.select({ memberId: schema.member.id })
			.from(schema.project)
			.leftJoin(schema.member, and(eq(schema.member.organizationId, schema.project.organizationId), eq(schema.member.userId, userId)))
			.where(and(eq(schema.project.id, projectId), isNull(schema.project.deletedAt)))
			.limit(1);

		if (projectMember.length === 0 || !projectMember[0].memberId) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'Forbidden');
		}

		if (!body.favorite) {
			await database
				.delete(schema.userProjectFavorite)
				.where(and(eq(schema.userProjectFavorite.userId, userId), eq(schema.userProjectFavorite.projectId, projectId)));

			return c.json({ projectId, favorite: body.favorite });
		}

		await database
			.insert(schema.userProjectFavorite)
			.values({
				id: crypto.randomUUID(),
				userId,
				projectId,
				createdAt: new Date(),
			})
			.onConflictDoNothing({ target: [schema.userProjectFavorite.userId, schema.userProjectFavorite.projectId] });

		return c.json({ projectId, favorite: body.favorite });
	})

	// GET /api/user/account/delete-preview — Preview account deletion consequences
	.get('/user/account/delete-preview', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB);

		// Find all orgs the user belongs to
		const memberships = await database
			.select({
				organizationId: schema.member.organizationId,
				role: schema.member.role,
			})
			.from(schema.member)
			.where(eq(schema.member.userId, userId));

		const blockers: Array<{ id: string; name: string; memberCount: number }> = [];
		const singleMemberOrganizations: Array<{ id: string; name: string; projectCount: number }> = [];
		const membershipOrganizations: Array<{ id: string; name: string }> = [];

		for (const membership of memberships) {
			// Count all members in this org
			const allMembers = await database
				.select({ userId: schema.member.userId, role: schema.member.role })
				.from(schema.member)
				.where(eq(schema.member.organizationId, membership.organizationId));

			const organizationRows = await database
				.select({ name: schema.organization.name })
				.from(schema.organization)
				.where(eq(schema.organization.id, membership.organizationId))
				.limit(1);
			const organizationName = organizationRows[0]?.name ?? 'Unknown';

			if (allMembers.length === 1) {
				// Single-member org — will be auto-deleted
				const projectCount = await database
					.select({ id: schema.project.id })
					.from(schema.project)
					.where(and(eq(schema.project.organizationId, membership.organizationId), isNull(schema.project.deletedAt)));

				singleMemberOrganizations.push({
					id: membership.organizationId,
					name: organizationName,
					projectCount: projectCount.length,
				});
			} else {
				// Multi-member org
				const otherSuperAdmins = allMembers.filter((m) => m.role === 'owner' && m.userId !== userId);

				if (membership.role === 'owner' && otherSuperAdmins.length === 0) {
					// Sole super admin of multi-member org — BLOCKER
					blockers.push({
						id: membership.organizationId,
						name: organizationName,
						memberCount: allMembers.length,
					});
				} else {
					// Other super admins exist, or user is not a super admin — safe to remove
					membershipOrganizations.push({
						id: membership.organizationId,
						name: organizationName,
					});
				}
			}
		}

		return c.json({
			canDelete: blockers.length === 0,
			blockers,
			singleMemberOrganizations,
			membershipOrganizations,
		});
	})

	// DELETE /api/user/account — Soft-delete user account
	.delete('/user/account', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB);

		// Pre-check: find all orgs where user is sole super admin of multi-member org.
		// Cache member lists per org to avoid re-querying in the classification loop below.
		const memberships = await database
			.select({
				organizationId: schema.member.organizationId,
				role: schema.member.role,
			})
			.from(schema.member)
			.where(eq(schema.member.userId, userId));

		const orgMemberCache = new Map<string, Array<{ userId: string; role: string }>>();

		for (const membership of memberships) {
			const allMembers = await database
				.select({ userId: schema.member.userId, role: schema.member.role })
				.from(schema.member)
				.where(eq(schema.member.organizationId, membership.organizationId));

			orgMemberCache.set(membership.organizationId, allMembers);

			if (membership.role === 'owner' && allMembers.length > 1) {
				const otherSuperAdmins = allMembers.filter((m) => m.role === 'owner' && m.userId !== userId);
				if (otherSuperAdmins.length === 0) {
					throw httpError(
						HttpErrorCode.VALIDATION_ERROR,
						'Cannot delete account: you are the sole super admin of a multi-member organization. Promote another member or delete the organization first.',
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 409 Conflict is not in Hono's standard status type
						409 as 400,
					);
				}
			}
		}

		const now = new Date();

		// Classify memberships by org size using cached member data
		const singleMemberOrgIds: string[] = [];
		const multiMemberOrgIds: string[] = [];

		for (const membership of memberships) {
			const allMembers = orgMemberCache.get(membership.organizationId);
			if (allMembers && allMembers.length === 1) {
				singleMemberOrgIds.push(membership.organizationId);
			} else {
				multiMemberOrgIds.push(membership.organizationId);
			}
		}

		// Batch single-member org cleanup (cancel transfers, soft-delete projects, delete org)
		for (const orgId of singleMemberOrgIds) {
			await database.batch([
				database
					.update(schema.projectTransfer)
					.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
					.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.sourceOrganizationId, orgId))),
				database
					.update(schema.projectTransfer)
					.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
					.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.targetOrganizationId, orgId))),
				database
					.update(schema.project)
					.set({ deletedAt: now, updatedAt: now })
					.where(and(eq(schema.project.organizationId, orgId), isNull(schema.project.deletedAt))),
				database.delete(schema.organization).where(eq(schema.organization.id, orgId)),
			]);
		}

		// Batch multi-member org membership removals
		for (const orgId of multiMemberOrgIds) {
			await database.delete(schema.member).where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)));
		}

		// Batch the final user-level cleanup
		await database.batch([
			// Cancel any pending transfers initiated by the user
			database
				.update(schema.projectTransfer)
				.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
				.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.initiatedByUserId, userId))),
			// Soft-delete the user
			database.update(schema.user).set({ deletedAt: now, updatedAt: now }).where(eq(schema.user.id, userId)),
			// Delete all sessions
			database.delete(schema.session).where(eq(schema.session.userId, userId)),
		]);

		trackAuthEvent({ userId, eventType: 'account_delete', request: c.req.raw });

		return c.json({ ok: true, deletedAt: now.toISOString() });
	})

	// =========================================================================
	// Push Notification Subscription Management
	// =========================================================================

	// GET /api/user/push-vapid-key — Get the VAPID public key for pushManager.subscribe()
	.get('/user/push-vapid-key', async (c) => {
		const key = await c.env.PUSH.getVapidPublicKey();
		return c.json({ key });
	})

	// POST /api/user/push-subscription — Register a push subscription
	.post('/user/push-subscription', zValidator('json', pushSubscriptionBodySchema), async (c) => {
		const { userId } = c.get('session');
		const body = c.req.valid('json');

		await c.env.PUSH.registerSubscription(userId, {
			endpoint: body.endpoint,
			key: body.key,
			auth: body.auth,
		});

		return c.json({ ok: true });
	})

	// DELETE /api/user/push-subscription — Unregister a push subscription
	.delete('/user/push-subscription', zValidator('json', pushUnsubscribeBodySchema), async (c) => {
		const { userId } = c.get('session');
		const body = c.req.valid('json');

		await c.env.PUSH.unregisterSubscription(userId, body.endpoint);

		return c.json({ ok: true });
	})

	// =========================================================================
	// Push Notification Preference (per-device enabled/disabled)
	// =========================================================================

	// GET /api/user/push-notification-preference — Get preference for a device
	.get('/user/push-notification-preference', async (c) => {
		const { userId } = c.get('session');
		const endpoint = c.req.query('endpoint');

		if (!endpoint) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Query parameter "endpoint" is required.');
		}

		const preference = await c.env.PUSH.getNotificationPreference(userId, endpoint);
		return c.json({ enabled: preference?.enabled ?? false });
	})

	// PUT /api/user/push-notification-preference — Set preference for a device
	.put('/user/push-notification-preference', zValidator('json', pushNotificationPreferenceBodySchema), async (c) => {
		const { userId } = c.get('session');
		const body = c.req.valid('json');

		await c.env.PUSH.setNotificationPreference(userId, body.endpoint, body.enabled);

		return c.json({ ok: true });
	})

	// GET /api/user/preferences — All user preferences merged with defaults
	.get('/user/preferences', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB);

		const rows = await database
			.select({ key: schema.userPreference.key, value: schema.userPreference.value })
			.from(schema.userPreference)
			.where(eq(schema.userPreference.userId, userId));

		const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
		return c.json(resolveUserPreferences(stored));
	})

	// PUT /api/user/preferences — Upsert one or more preference key-value pairs
	.put('/user/preferences', zValidator('json', userPreferencesBodySchema), async (c) => {
		const { userId } = c.get('session');
		const preferences = c.req.valid('json');
		const database = drizzle(c.env.DB);
		const now = new Date();

		// Upsert each preference. Typically 1-2 keys per call.
		for (const [key, value] of Object.entries(preferences)) {
			await database
				.insert(schema.userPreference)
				.values({ userId, key, value, updatedAt: now })
				.onConflictDoUpdate({
					target: [schema.userPreference.userId, schema.userPreference.key],
					set: { value, updatedAt: now },
				});
		}

		return c.json({ ok: true });
	});

export type UserRoutes = typeof userRoutes;
