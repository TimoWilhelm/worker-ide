import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sharedAlias = {
	'@': path.resolve(__dirname, './src'),
	'@shared': path.resolve(__dirname, './shared'),
	'@server': path.resolve(__dirname, './worker'),
};

export default defineConfig({
	resolve: {
		alias: sharedAlias,
	},
	test: {
		projects: [
			// Unit tests - shared utilities, store, pure logic (Node environment)
			{
				test: {
					name: 'unit',
					include: ['shared/**/*.test.ts', 'src/lib/**/*.test.ts', 'auxiliary/**/*.test.ts'],
					environment: 'node',
				},
				resolve: {
					alias: sharedAlias,
				},
			},
			// Worker tests - run inside workerd via @cloudflare/vitest-pool-workers
			defineWorkersProject({
				test: {
					name: 'worker',
					include: ['worker/**/*.test.ts'],
					exclude: ['worker/fixtures/**'],
					// Pre-bundle CJS-only dependencies so workerd's ESM runtime can resolve
					// their named exports. See: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution
					deps: {
						optimizer: {
							ssr: {
								enabled: true,
								include: ['@tanstack/ai'],
							},
						},
					},
					poolOptions: {
						workers: {
							miniflare: {
								// The BIOME service binding points to the auxiliary biome-worker which
								// is not available in the test pool. Override it with an empty stub so
								// miniflare can start. The biome-linter RPC client handles errors
								// gracefully (returns [] / failure objects).
								serviceBindings: {
									BIOME: () => new Response('service unavailable', { status: 503 }),
								},
							},
							wrangler: {
								configPath: './wrangler.jsonc',
							},
						},
					},
				},
				resolve: {
					alias: sharedAlias,
				},
			}),
			// React component tests - hooks, components
			{
				define: {
					__APP_VERSION__: JSON.stringify('test-version'),
				},
				test: {
					name: 'react',
					include: ['src/**/*.test.tsx', 'src/features/**/*.test.ts', 'src/hooks/**/*.test.ts'],
					exclude: ['src/lib/**/*.test.ts'],
					environment: 'jsdom',
					setupFiles: ['./src/test-setup.ts'],
				},
				resolve: {
					alias: sharedAlias,
				},
			},
		],
	},
});
