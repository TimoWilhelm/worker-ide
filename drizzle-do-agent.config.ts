import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	out: './worker/migrations/do-agent',
	schema: './worker/durable/db/schema.ts',
	dialect: 'sqlite',
	driver: 'durable-sqlite',
});
