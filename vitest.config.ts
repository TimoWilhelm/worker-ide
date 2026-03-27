import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sharedAlias = {
	'@': path.resolve(__dirname, './src'),
	'@shared': path.resolve(__dirname, './shared'),
	'@server': path.resolve(__dirname, './worker'),
	'@worker': path.resolve(__dirname, './worker'),
	'@git': path.resolve(__dirname, './auxiliary/git'),
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
								include: ['ai'],
							},
						},
					},
					poolOptions: {
						workers: {
							miniflare: {
								// Auxiliary workers (biome, esbuild, git) are not available in the
								// test pool. Override their bindings with stubs so miniflare can start.
								serviceBindings: {
									BIOME: () => new Response('service unavailable', { status: 503 }),
									ESBUILD: () => new Response('service unavailable', { status: 503 }),
								},
								// The REPO_DO cross-worker DO binding references git-worker which
								// isn't available in tests. Remove the script_name so miniflare
								// doesn't try to resolve it. Git integration tests use a separate config.
								durableObjects: {
									REPO_DO: 'RepoDurableObject',
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
