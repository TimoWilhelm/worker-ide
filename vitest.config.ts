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
					include: [
						'shared/**/*.test.ts',
						'src/lib/**/*.test.ts',
						'worker/services/ai-agent/lib/**/*.test.ts',
						'worker/services/ai-agent/tools/lint-fix-biome.test.ts',
					],
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
					exclude: [
						// Biome WASM tests run in the unit (Node) project because the 27 MiB
						// WASM binary cannot load inside the workerd sandbox.
						'worker/services/ai-agent/lib/**/*.test.ts',
						'worker/services/ai-agent/tools/lint-fix-biome.test.ts',
					],
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
