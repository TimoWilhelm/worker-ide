import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
			'@shared': path.resolve(__dirname, './shared'),
			'@server': path.resolve(__dirname, './worker'),
		},
	},
	test: {
		projects: [
			// Unit tests - shared utilities, store, pure logic
			{
				test: {
					name: 'unit',
					include: ['shared/**/*.test.ts', 'src/lib/**/*.test.ts', 'worker/**/*.test.ts'],
					environment: 'node',
				},
				resolve: {
					alias: {
						'@': path.resolve(__dirname, './src'),
						'@shared': path.resolve(__dirname, './shared'),
						'@server': path.resolve(__dirname, './worker'),
					},
				},
			},
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
					alias: {
						'@': path.resolve(__dirname, './src'),
						'@shared': path.resolve(__dirname, './shared'),
						'@server': path.resolve(__dirname, './worker'),
					},
				},
			},
		],
	},
});
