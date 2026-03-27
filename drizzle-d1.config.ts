import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	out: './worker/migrations/d1-auth',
	schema: './worker/db/auth-schema.ts',
	dialect: 'sqlite',
});
