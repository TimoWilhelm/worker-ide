/**
 * User-scoped routes.
 *
 * Handles per-user operations that are not scoped to a specific organization:
 * - Recently accessed projects (cross-org)
 * - Project favorites
 * - Account deletion preview and execution
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';

import * as schema from '../db/auth-schema';
import { httpError } from '../lib/http-error';

import type { AuthedEnvironment } from '../types';

const MAX_RECENT_PROJECTS = 20;

export const userRoutes = new Hono<AuthedEnvironment>()
	// GET /api/user/recent-projects — Recently accessed projects across all orgs
	.get('/user/recent-projects', async (c) => {
		const userId = c.get('userId');
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

		// Get project details for accessed projects (only non-deleted, non-banned ones in user's non-banned orgs)
		const projects = await database
			.select({
				id: schema.project.id,
				organizationId: schema.project.organizationId,
				name: schema.project.name,
				humanId: schema.project.humanId,
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
		const projectsWithAccess = projects
			.map((project) => {
				const access = accessMap.get(project.id);
				const organization = organizationMap.get(project.organizationId);
				return {
					...project,
					lastAccessedAt: access?.lastAccessedAt.toISOString() ?? project.updatedAt.toISOString(),
					isFavorite: access?.isFavorite ?? false,
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

	// POST /api/user/project/:projectId/access — Record a project access
	.post('/user/project/:projectId/access', async (c) => {
		const userId = c.get('userId');
		const { projectId } = c.req.param();
		const database = drizzle(c.env.DB);

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

		const now = new Date();

		// Atomic upsert using the unique index on (userId, projectId)
		await database
			.insert(schema.userProjectAccess)
			.values({
				id: crypto.randomUUID(),
				userId,
				projectId,
				lastAccessedAt: now,
				isFavorite: false,
			})
			.onConflictDoUpdate({
				target: [schema.userProjectAccess.userId, schema.userProjectAccess.projectId],
				set: { lastAccessedAt: now },
			});

		return c.json({ ok: true });
	})

	// PUT /api/user/project/:projectId/favorite — Toggle favorite status
	.put('/user/project/:projectId/favorite', async (c) => {
		const userId = c.get('userId');
		const { projectId } = c.req.param();
		const database = drizzle(c.env.DB);

		const body = await c.req.json<{ favorite: boolean }>();
		if (typeof body.favorite !== 'boolean') {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Body must contain a boolean "favorite" field.');
		}

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

		// Atomic upsert using the unique index on (userId, projectId)
		await database
			.insert(schema.userProjectAccess)
			.values({
				id: crypto.randomUUID(),
				userId,
				projectId,
				lastAccessedAt: new Date(),
				isFavorite: body.favorite,
			})
			.onConflictDoUpdate({
				target: [schema.userProjectAccess.userId, schema.userProjectAccess.projectId],
				set: { isFavorite: body.favorite },
			});

		return c.json({ projectId, favorite: body.favorite });
	})

	// GET /api/user/account/delete-preview — Preview account deletion consequences
	.get('/user/account/delete-preview', async (c) => {
		const userId = c.get('userId');
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
		const userId = c.get('userId');
		const database = drizzle(c.env.DB);

		// Pre-check: find all orgs where user is sole super admin of multi-member org
		const memberships = await database
			.select({
				organizationId: schema.member.organizationId,
				role: schema.member.role,
			})
			.from(schema.member)
			.where(eq(schema.member.userId, userId));

		for (const membership of memberships) {
			if (membership.role !== 'owner') continue;

			const allMembers = await database
				.select({ userId: schema.member.userId, role: schema.member.role })
				.from(schema.member)
				.where(eq(schema.member.organizationId, membership.organizationId));

			if (allMembers.length > 1) {
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

		// Process each org membership
		for (const membership of memberships) {
			const allMembers = await database
				.select({ userId: schema.member.userId })
				.from(schema.member)
				.where(eq(schema.member.organizationId, membership.organizationId));

			if (allMembers.length === 1) {
				// Single-member org: cancel transfers, soft-delete projects, delete org
				await database
					.update(schema.projectTransfer)
					.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
					.where(
						and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.sourceOrganizationId, membership.organizationId)),
					);
				await database
					.update(schema.projectTransfer)
					.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
					.where(
						and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.targetOrganizationId, membership.organizationId)),
					);

				// Soft-delete all projects
				await database
					.update(schema.project)
					.set({ deletedAt: now, updatedAt: now })
					.where(and(eq(schema.project.organizationId, membership.organizationId), isNull(schema.project.deletedAt)));

				// Delete org (members, invitations cascade)
				await database.delete(schema.organization).where(eq(schema.organization.id, membership.organizationId));
			} else {
				// Multi-member org: just remove membership
				await database
					.delete(schema.member)
					.where(and(eq(schema.member.organizationId, membership.organizationId), eq(schema.member.userId, userId)));
			}
		}

		// Cancel any pending transfers initiated by the user
		await database
			.update(schema.projectTransfer)
			.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
			.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.initiatedByUserId, userId)));

		// Soft-delete the user
		await database.update(schema.user).set({ deletedAt: now, updatedAt: now }).where(eq(schema.user.id, userId));

		// Delete all sessions
		await database.delete(schema.session).where(eq(schema.session.userId, userId));

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
	.post('/user/push-subscription', async (c) => {
		const userId = c.get('userId');
		const body = await c.req.json<{ endpoint: string; key: string; auth: string }>();

		if (!body.endpoint || !body.key || !body.auth) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Body must contain endpoint, key, and auth fields.');
		}

		await c.env.PUSH.registerSubscription(userId, {
			endpoint: body.endpoint,
			key: body.key,
			auth: body.auth,
		});

		return c.json({ ok: true });
	})

	// DELETE /api/user/push-subscription — Unregister a push subscription
	.delete('/user/push-subscription', async (c) => {
		const userId = c.get('userId');
		const body = await c.req.json<{ endpoint: string }>();

		if (!body.endpoint) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Body must contain an endpoint field.');
		}

		await c.env.PUSH.unregisterSubscription(userId, body.endpoint);

		return c.json({ ok: true });
	});

export type UserRoutes = typeof userRoutes;
