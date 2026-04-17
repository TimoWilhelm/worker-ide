import { and, eq } from 'drizzle-orm';

import { HttpErrorCode } from '@shared/http-errors';

import { httpError } from './http-error';
import * as schema from '../db/auth-schema';

import type { DrizzleD1Database } from 'drizzle-orm/d1';

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
