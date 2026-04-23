import { and, count, eq, isNull } from 'drizzle-orm';

import { PLAN_FREE } from '@shared/constants';
import { resolveUserLimitsFromRows } from '@shared/entitlements';

import { queryEntitlements } from './entitlements';
import * as schema from '../db/auth-schema';

import type { DrizzleD1Database } from 'drizzle-orm/d1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts schema and non-schema drizzle clients
type Database = DrizzleD1Database<any>;

export async function shouldBlockOrganizationCreate(database: Database, userId: string): Promise<boolean> {
	const [entitlementRows, freeOrganizationCountRows] = await Promise.all([
		queryEntitlements(database, userId),
		database
			.select({ count: count() })
			.from(schema.member)
			.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
			.where(and(eq(schema.member.userId, userId), eq(schema.organization.plan, PLAN_FREE), isNull(schema.organization.deletedAt))),
	]);
	const { maxFreeOrganizations } = resolveUserLimitsFromRows(entitlementRows);
	const freeOrganizationCount = freeOrganizationCountRows[0]?.count ?? 0;

	return freeOrganizationCount >= maxFreeOrganizations;
}
