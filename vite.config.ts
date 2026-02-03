import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
	plugins: [
		cloudflare({
			configPath: './wrangler.jsonc',
		}),
	],
	resolve: {
		alias: {
			'node:fs/promises': 'worker-fs-mount/fs',
		},
	},
	server: {
		port: 5173,
		hmr: {
			protocol: 'ws',
			host: 'localhost',
		},
	},
});
