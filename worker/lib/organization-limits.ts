import { and, count, eq, isNull } from 'drizzle-orm';

import { PLAN_FREE } from '@shared/constants';
import { EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS } from '@shared/limits';

import { getEffectiveLimit } from './limits';
import * as schema from '../db/auth-schema';

import type { Database } from './limits';

export async function getCurrentFreeOrganizationCount(database: Database, userId: string): Promise<number> {
	const freeOrganizationCountRows = await database
		.select({ count: count() })
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
		.where(and(eq(schema.member.userId, userId), eq(schema.organization.plan, PLAN_FREE), isNull(schema.organization.deletedAt)));

	return freeOrganizationCountRows[0]?.count ?? 0;
}

export async function shouldBlockOrganizationCreate(database: Database, userId: string): Promise<boolean> {
	const [maxFreeOrganizations, freeOrganizationCount] = await Promise.all([
		getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS, userId }),
		getCurrentFreeOrganizationCount(database, userId),
	]);

	return freeOrganizationCount >= maxFreeOrganizations;
}
