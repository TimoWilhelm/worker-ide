/**
 * Drizzle client factory for Durable Object SQLite storage.
 *
 * The `durable-sqlite` driver accepts `DurableObjectStorage` directly
 * (not `storage.sql`) and operates synchronously — matching Cloudflare's
 * synchronous SQLite API on Durable Objects.
 */

import { drizzle } from 'drizzle-orm/durable-sqlite';

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

export type AgentDatabase = DrizzleSqliteDODatabase;

/**
 * Create a Drizzle database instance from Durable Object storage.
 *
 * Call this once during DO initialization (e.g., in `onStart()` inside
 * `blockConcurrencyWhile`) and reuse the instance for all queries.
 */
export function getDatabase(storage: DurableObjectStorage): AgentDatabase {
	return drizzle(storage);
}
