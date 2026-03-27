/**
 * Organization-scoped routes.
 *
 * Handles project listing for the active organization and
 * project visibility toggling. All routes require authentication
 * and an active organization.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';

import * as schema from '../db/auth-schema';
import { httpError } from '../lib/http-error';

import type { AuthedEnvironment } from '../types';

export const orgRoutes = new Hono<AuthedEnvironment>()
	// Verify the user is a member of the active organization on all org routes
	.use('/org/*', async (c, next) => {
		const organizationId = c.get('activeOrganizationId');
		if (!organizationId) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'No active organization. Set an active organization first.');
		}
		const userId = c.get('userId');
		const database = drizzle(c.env.DB);
		const memberRow = await database
			.select({ id: schema.member.id })
			.from(schema.member)
			.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
			.limit(1);
		if (memberRow.length === 0) {
			throw httpError(HttpErrorCode.PROTECTED_FILE, 'You are not a member of this organization.');
		}
		await next();
	})

	// GET /api/org/projects — List projects for the active organization
	.get('/org/projects', async (c) => {
		const organizationId = c.get('activeOrganizationId')!;

		const database = drizzle(c.env.DB);
		const projects = await database
			.select()
			.from(schema.project)
			.where(and(eq(schema.project.organizationId, organizationId), isNull(schema.project.deletedAt)))
			.orderBy(schema.project.createdAt);

		return c.json({ projects });
	})

	// PUT /api/org/project/:projectId/visibility — Toggle preview visibility
	.put('/org/project/:projectId/visibility', async (c) => {
		const { projectId } = c.req.param();
		const organizationId = c.get('activeOrganizationId')!;

		const body = await c.req.json<{ visibility: string }>();
		if (body.visibility !== 'public' && body.visibility !== 'private') {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Visibility must be "public" or "private".');
		}

		const database = drizzle(c.env.DB);
		const existing = await database
			.select()
			.from(schema.project)
			.where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, organizationId)))
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

	// DELETE /api/org/project/:projectId — Soft-delete a project (30-day retention)
	.delete('/org/project/:projectId', async (c) => {
		const { projectId } = c.req.param();
		const organizationId = c.get('activeOrganizationId')!;

		const database = drizzle(c.env.DB);
		const existing = await database
			.select()
			.from(schema.project)
			.where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, organizationId), isNull(schema.project.deletedAt)))
			.limit(1);

		if (existing.length === 0) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Project not found in this organization.');
		}

		const now = new Date();
		await database.update(schema.project).set({ deletedAt: now, updatedAt: now }).where(eq(schema.project.id, projectId));

		return c.json({ projectId, deletedAt: now.toISOString() });
	});

export type OrgRoutes = typeof orgRoutes;
