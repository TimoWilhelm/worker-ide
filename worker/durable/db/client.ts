import { drizzle } from 'drizzle-orm/durable-sqlite';

import * as schema from './schema';

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

export type AgentDatabase = DrizzleSqliteDODatabase<typeof schema>;

/**
 * Create a Drizzle database instance from Durable Object storage.
 *
 * Call this once during DO initialization (e.g., in `onStart()` inside
 * `blockConcurrencyWhile`) and reuse the instance for all queries.
 */
export function getDatabase(storage: DurableObjectStorage): AgentDatabase {
	return drizzle(storage, { schema });
}
