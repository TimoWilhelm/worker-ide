import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	out: './worker/drizzle',
	schema: './worker/durable/db/schema.ts',
	dialect: 'sqlite',
	driver: 'durable-sqlite',
});
