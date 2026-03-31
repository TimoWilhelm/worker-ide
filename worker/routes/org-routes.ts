/**
 * Organization-scoped routes.
 *
 * Handles project listing, visibility toggling, and project deletion
 * for a specific organization identified by :orgId in the URL path.
 * All routes require authentication and org membership.
 */

import { and, count, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { resolveOrgLimitsFromRows } from '@shared/entitlements';
import { HttpErrorCode } from '@shared/http-errors';

import * as schema from '../db/auth-schema';
import { queryEntitlements } from '../lib/entitlements';
import { httpError } from '../lib/http-error';
import { assertOrgSuperAdmin } from '../lib/project-auth';

import type { AuthedEnvironment } from '../types';

export const orgRoutes = new Hono<AuthedEnvironment>()
	// Verify the user is a member of the :orgId organization and the org is not banned
	.use('/org/:orgId/*', async (c, next) => {
		const { orgId } = c.req.param();
		const userId = c.get('userId');
		const database = drizzle(c.env.DB);

		// Single query: check membership + org ban
		const orgMemberRow = await database
			.select({
				memberId: schema.member.id,
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
			database.select({ count: count() }).from(schema.member).where(eq(schema.member.organizationId, orgId)),
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
			.select()
			.from(schema.project)
			.where(and(eq(schema.project.organizationId, orgId), isNull(schema.project.deletedAt), isNull(schema.project.bannedAt)))
			.orderBy(schema.project.createdAt);

		return c.json({ projects });
	})

	// PUT /api/org/:orgId/project/:projectId/visibility — Toggle preview visibility
	.put('/org/:orgId/project/:projectId/visibility', async (c) => {
		const { orgId, projectId } = c.req.param();

		const body = await c.req.json<{ visibility: string }>();
		if (body.visibility !== 'public' && body.visibility !== 'private') {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Visibility must be "public" or "private".');
		}

		const database = drizzle(c.env.DB);
		const existing = await database
			.select()
			.from(schema.project)
			.where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId), isNull(schema.project.bannedAt)))
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
		await database.update(schema.project).set({ deletedAt: now, updatedAt: now }).where(eq(schema.project.id, projectId));

		return c.json({ projectId, deletedAt: now.toISOString() });
	})

	// DELETE /api/org/:orgId — Delete an organization (super admin only)
	.delete('/org/:orgId', async (c) => {
		const { orgId } = c.req.param();
		const userId = c.get('userId');
		const database = drizzle(c.env.DB);

		// Only super admins (owners) can delete an org
		await assertOrgSuperAdmin(database, orgId, userId);

		const now = new Date();

		// Atomically: cancel transfers, soft-delete projects, and remove the org
		await database.batch([
			// Cancel all OUTGOING pending transfers
			database
				.update(schema.projectTransfer)
				.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
				.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.sourceOrganizationId, orgId))),
			// Cancel all INCOMING pending transfers
			database
				.update(schema.projectTransfer)
				.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
				.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.targetOrganizationId, orgId))),
			// Soft-delete all projects in the org
			database
				.update(schema.project)
				.set({ deletedAt: now, updatedAt: now })
				.where(and(eq(schema.project.organizationId, orgId), isNull(schema.project.deletedAt))),
			// Delete the organization (members and invitations cascade via FK)
			database.delete(schema.organization).where(eq(schema.organization.id, orgId)),
		]);

		return c.json({ organizationId: orgId, deletedAt: now.toISOString() });
	});

export type OrgRoutes = typeof orgRoutes;
