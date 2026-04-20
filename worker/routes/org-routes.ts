import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { resolveOrgLimitsFromRows } from '@shared/entitlements';
import { HttpErrorCode } from '@shared/http-errors';
import { visibilityBodySchema } from '@shared/validation';

import * as schema from '../db/auth-schema';
import { trackProjectEvent } from '../lib/analytics';
import { queryEntitlements } from '../lib/entitlements';
import { httpError } from '../lib/http-error';
import { assertOrgSuperAdmin } from '../lib/project-auth';

import type { AuthedEnvironment } from '../types';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

const PROJECT_DELETED_VIA_PROJECT = 'project';
const PROJECT_DELETED_VIA_ORGANIZATION = 'organization';

export async function softDeleteProjectById(
	database: DrizzleD1Database,
	projectId: string,
	now: Date,
	deletedViaType: string,
	deletedViaId: string,
	resolvedByUserId?: string,
): Promise<void> {
	await database.batch([
		database
			.update(schema.project)
			.set({ deletedAt: now, deletedViaType, deletedViaId, updatedAt: now })
			.where(and(eq(schema.project.id, projectId), isNull(schema.project.deletedAt))),
		database
			.update(schema.projectTransfer)
			.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId })
			.where(and(eq(schema.projectTransfer.projectId, projectId), eq(schema.projectTransfer.status, 'pending'))),
	]);
}

export async function softDeleteOrganizationById(
	database: DrizzleD1Database,
	organizationId: string,
	now: Date,
	resolvedByUserId?: string,
): Promise<void> {
	await database.batch([
		database
			.update(schema.projectTransfer)
			.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId })
			.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.sourceOrganizationId, organizationId))),
		database
			.update(schema.projectTransfer)
			.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId })
			.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.targetOrganizationId, organizationId))),
		database
			.update(schema.project)
			.set({ deletedAt: now, deletedViaType: PROJECT_DELETED_VIA_ORGANIZATION, deletedViaId: organizationId, updatedAt: now })
			.where(and(eq(schema.project.organizationId, organizationId), isNull(schema.project.deletedAt))),
		database.update(schema.organization).set({ deletedAt: now }).where(eq(schema.organization.id, organizationId)),
		database
			.update(schema.session)
			// eslint-disable-next-line unicorn/no-null -- D1 requires null to clear nullable columns
			.set({ activeOrganizationId: null, updatedAt: now })
			.where(eq(schema.session.activeOrganizationId, organizationId)),
	]);
}

export const orgRoutes = new Hono<AuthedEnvironment>()
	// Verify the user is a member of the :orgId organization and the org is not banned
	.use('/org/:orgId/*', async (c, next) => {
		const { orgId } = c.req.param();
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB);

		// Single query: check membership + org ban
		const orgMemberRow = await database
			.select({
				memberId: schema.member.id,
				orgDeletedAt: schema.organization.deletedAt,
				orgBannedAt: schema.organization.bannedAt,
			})
			.from(schema.organization)
			.leftJoin(schema.member, and(eq(schema.member.organizationId, schema.organization.id), eq(schema.member.userId, userId)))
			.where(eq(schema.organization.id, orgId))
			.limit(1);

		if (orgMemberRow.length === 0) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'Forbidden');
		}

		if (orgMemberRow[0].orgBannedAt) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'Please contact us for assistance.');
		}

		if (orgMemberRow[0].orgDeletedAt) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Organization not found.');
		}

		if (!orgMemberRow[0].memberId) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'You are not a member of this organization.');
		}

		await next();
	})

	// GET /api/org/:orgId/limits — Resolved limits + current usage for this organization
	.get('/org/:orgId/limits', async (c) => {
		const { orgId } = c.req.param();
		const database = drizzle(c.env.DB);

		// Fetch org plan, entitlements, and current counts in parallel
		const [organizationRows, entitlementRows, projectCountRows, memberCountRows] = await Promise.all([
			database.select({ plan: schema.organization.plan }).from(schema.organization).where(eq(schema.organization.id, orgId)).limit(1),
			queryEntitlements(database, orgId),
			database
				.select({ count: count() })
				.from(schema.project)
				.where(and(eq(schema.project.organizationId, orgId), isNull(schema.project.deletedAt))),
			database
				.select({ count: count() })
				.from(schema.member)
				.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
				.where(and(eq(schema.member.organizationId, orgId), isNull(schema.user.deletedAt))),
		]);

		const plan = organizationRows[0]?.plan ?? 'free';
		const limits = resolveOrgLimitsFromRows(plan, entitlementRows);

		return c.json({
			maxProjects: limits.maxProjects,
			currentProjects: projectCountRows[0]?.count ?? 0,
			maxMembers: limits.maxMembers,
			currentMembers: memberCountRows[0]?.count ?? 0,
		});
	})

	// GET /api/org/:orgId/projects — List projects for the organization
	.get('/org/:orgId/projects', async (c) => {
		const { orgId } = c.req.param();

		const database = drizzle(c.env.DB);
		const projects = await database
			.select({
				id: schema.project.id,
				organizationId: schema.project.organizationId,
				durableObjectHexId: schema.project.durableObjectHexId,
				name: schema.project.name,
				previewVisibility: schema.project.previewVisibility,
				createdAt: schema.project.createdAt,
				updatedAt: schema.project.updatedAt,
				deletedAt: schema.project.deletedAt,
				bannedAt: schema.project.bannedAt,
				lastActivityAt: schema.project.lastActivityAt,
			})
			.from(schema.project)
			.where(and(eq(schema.project.organizationId, orgId), isNull(schema.project.deletedAt), isNull(schema.project.bannedAt)))
			.orderBy(desc(schema.project.lastActivityAt));

		return c.json({ projects });
	})

	// PUT /api/org/:orgId/project/:projectId/visibility — Toggle preview visibility
	.put('/org/:orgId/project/:projectId/visibility', zValidator('json', visibilityBodySchema), async (c) => {
		const { orgId, projectId } = c.req.param();

		const body = c.req.valid('json');

		const database = drizzle(c.env.DB);
		const existing = await database
			.select()
			.from(schema.project)
			.where(
				and(
					eq(schema.project.id, projectId),
					eq(schema.project.organizationId, orgId),
					isNull(schema.project.deletedAt),
					isNull(schema.project.bannedAt),
				),
			)
			.limit(1);

		if (existing.length === 0) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Project not found in this organization.');
		}

		await database
			.update(schema.project)
			.set({ previewVisibility: body.visibility, updatedAt: new Date() })
			.where(eq(schema.project.id, projectId));

		return c.json({ projectId, visibility: body.visibility });
	})

	// DELETE /api/org/:orgId/project/:projectId — Soft-delete a project (30-day retention)
	.delete('/org/:orgId/project/:projectId', async (c) => {
		const { orgId, projectId } = c.req.param();

		const database = drizzle(c.env.DB);
		const existing = await database
			.select()
			.from(schema.project)
			.where(
				and(
					eq(schema.project.id, projectId),
					eq(schema.project.organizationId, orgId),
					isNull(schema.project.deletedAt),
					isNull(schema.project.bannedAt),
				),
			)
			.limit(1);

		if (existing.length === 0) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Project not found in this organization.');
		}

		const now = new Date();
		await softDeleteProjectById(database, projectId, now, PROJECT_DELETED_VIA_PROJECT, projectId, c.get('session').userId);

		trackProjectEvent({
			organizationId: orgId,
			eventType: 'delete',
			projectId,
			userId: c.get('session').userId,
			durationMs: 0,
			success: true,
			request: c.req.raw,
		});

		return c.json({ projectId, deletedAt: now.toISOString() });
	})

	// DELETE /api/org/:orgId — Delete an organization (super admin only)
	.delete('/org/:orgId', async (c) => {
		const { orgId } = c.req.param();
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB);

		// Only super admins (owners) can delete an org
		await assertOrgSuperAdmin(database, orgId, userId);

		const now = new Date();

		await softDeleteOrganizationById(database, orgId, now, userId);

		return c.json({ organizationId: orgId, deletedAt: now.toISOString() });
	});

export type OrgRoutes = typeof orgRoutes;
