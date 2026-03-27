import { drizzle } from 'drizzle-orm/durable-sqlite';

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

export function getDb(storage: DurableObjectStorage, options?: { logger?: boolean }): DrizzleSqliteDODatabase {
	return drizzle(storage, { logger: options?.logger === true });
}
