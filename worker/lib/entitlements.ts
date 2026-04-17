import { eq } from 'drizzle-orm';

import * as schema from '../db/auth-schema';

import type { DrizzleD1Database } from 'drizzle-orm/d1';

// Accept any D1 drizzle instance (with or without schema type parameter).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle generic variance
type Database = DrizzleD1Database<any>;
export async function queryEntitlements(database: Database, scopeId: string) {
	return database
		.select({
			key: schema.entitlement.key,
			valueType: schema.entitlement.valueType,
			value: schema.entitlement.value,
		})
		.from(schema.entitlement)
		.where(eq(schema.entitlement.scopeId, scopeId));
}
