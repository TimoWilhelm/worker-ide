import { and, eq } from 'drizzle-orm';

import * as schema from '../db/auth-schema';

import type { EntitlementKey } from '@shared/entitlements';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

type Database = DrizzleD1Database<typeof schema>;

export async function queryEntitlement(database: Database, scopeId: string, key: EntitlementKey) {
	return database
		.select({
			key: schema.entitlement.key,
			valueType: schema.entitlement.valueType,
			value: schema.entitlement.value,
		})
		.from(schema.entitlement)
		.where(and(eq(schema.entitlement.scopeId, scopeId), eq(schema.entitlement.key, key)))
		.limit(1);
}
