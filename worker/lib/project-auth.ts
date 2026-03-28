/**
 * Project Authorization Helper
 *
 * Centralized authorization check for all project access points.
 * Verifies the user is a member of the organization that owns the project.
 *
 * Used by:
 * - IDE API routes (/p/:projectId/api/*)
 * - WebSocket connections (/p/:projectId/__ws)
 * - Agent connections (/p/:projectId/__agent)
 * - Preview subdomain (when previewVisibility is 'private')
 */

import { and, eq } from 'drizzle-orm';

import { HttpErrorCode } from '@shared/http-errors';

import { httpError } from './http-error';
import * as schema from '../db/auth-schema';

import type { DrizzleD1Database } from 'drizzle-orm/d1';

/**
 * Check if a user is a member of an organization.
 *
 * @returns true if the user is a member, false otherwise.
 */
async function isOrgMember(database: DrizzleD1Database, organizationId: string, userId: string): Promise<boolean> {
	const memberRow = await database
		.select({ id: schema.member.id })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
		.limit(1);

	return memberRow.length > 0;
}

/**
 * Assert that a user is a member of an organization.
 *
 * @throws HTTPException 403 if the user is not a member.
 */
export async function assertOrgMember(database: DrizzleD1Database, organizationId: string, userId: string): Promise<void> {
	const isMember = await isOrgMember(database, organizationId, userId);
	if (!isMember) {
		throw httpError(HttpErrorCode.FORBIDDEN, 'You are not a member of this organization.');
	}
}

/**
 * Get the user's role in an organization.
 *
 * @returns The role string ('owner', 'admin', 'member') or undefined if not a member.
 */
async function getOrgRole(database: DrizzleD1Database, organizationId: string, userId: string): Promise<string | undefined> {
	const memberRow = await database
		.select({ role: schema.member.role })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
		.limit(1);

	return memberRow[0]?.role;
}

/**
 * Assert that a user is an admin or super admin (owner) of an organization.
 *
 * @throws HTTPException 403 if the user is not an admin/owner.
 */
export async function assertOrgAdmin(database: DrizzleD1Database, organizationId: string, userId: string): Promise<void> {
	const role = await getOrgRole(database, organizationId, userId);
	if (role !== 'owner' && role !== 'admin') {
		throw httpError(HttpErrorCode.FORBIDDEN, 'You must be an admin of this organization.');
	}
}

/**
 * Assert that a user is a super admin (owner) of an organization.
 *
 * @throws HTTPException 403 if the user is not an owner.
 */
export async function assertOrgSuperAdmin(database: DrizzleD1Database, organizationId: string, userId: string): Promise<void> {
	const role = await getOrgRole(database, organizationId, userId);
	if (role !== 'owner') {
		throw httpError(HttpErrorCode.FORBIDDEN, 'You must be a super admin of this organization.');
	}
}
