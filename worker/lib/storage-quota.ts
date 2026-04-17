import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { resolveProjectStorageQuotaFromRows } from '@shared/entitlements';

import { queryEntitlements } from './entitlements';
import * as schema from '../db/auth-schema';

/**
 * Resolve the effective storage quota (in bytes) for a project.
 *
 * Queries the project's organization to get the plan, then fetches
 * org-level and project-level entitlement overrides, and resolves:
 *   project override → org override → plan default.
 */
export async function resolveStorageQuotaForProject(projectId: string, database: D1Database): Promise<number> {
	const drizzleDatabase = drizzle(database);

	// Look up the project's organization and plan
	const projectRows = await drizzleDatabase
		.select({ organizationId: schema.project.organizationId })
		.from(schema.project)
		.where(eq(schema.project.id, projectId))
		.limit(1);

	if (projectRows.length === 0) {
		// Project not found — return free plan default
		const { getOrgLimits } = await import('@shared/constants/plans');
		return getOrgLimits('free').storageQuotaBytes;
	}

	const { organizationId } = projectRows[0];

	const organizationRows = await drizzleDatabase
		.select({ plan: schema.organization.plan })
		.from(schema.organization)
		.where(eq(schema.organization.id, organizationId))
		.limit(1);

	const plan = organizationRows[0]?.plan ?? 'free';

	// Fetch org and project entitlements in parallel
	const [orgEntitlementRows, projectEntitlementRows] = await Promise.all([
		queryEntitlements(drizzleDatabase, organizationId),
		queryEntitlements(drizzleDatabase, projectId),
	]);

	return resolveProjectStorageQuotaFromRows(plan, orgEntitlementRows, projectEntitlementRows);
}
