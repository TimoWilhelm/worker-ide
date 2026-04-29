import { drizzle } from 'drizzle-orm/d1';

import { EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES } from '@shared/limits';

import { getEffectiveLimit } from './limits';
import * as schema from '../db/auth-schema';

/**
 * Resolve the effective storage quota (in bytes) for a project.
 *
 * Resolves through the shared effective-limit loader, including the
 * fallback for missing projects.
 */
export async function resolveStorageQuotaForProject(projectId: string, database: D1Database): Promise<number> {
	const drizzleDatabase = drizzle(database, { schema });

	return getEffectiveLimit(drizzleDatabase, { key: EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES, projectId });
}
