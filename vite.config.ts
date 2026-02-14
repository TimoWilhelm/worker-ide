import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import type { Plugin } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function esbuildWasmPlugin(): Plugin {
	return {
		name: 'esbuild-wasm-plugin',
		buildStart() {
			const wasmSource = path.join(__dirname, 'node_modules/esbuild-wasm/esbuild.wasm');
			const vendorDirectory = path.join(__dirname, 'vendor');
			const wasmDestination = path.join(vendorDirectory, 'esbuild.wasm');
			if (existsSync(wasmSource)) {
				mkdirSync(vendorDirectory, { recursive: true });
				copyFileSync(wasmSource, wasmDestination);
			}
		},
	};
}

export default defineConfig({
	plugins: [
		esbuildWasmPlugin(),
		tailwindcss(),
		react(),
		cloudflare({
			configPath: './wrangler.jsonc',
		}),
	],
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
			'@shared': path.resolve(__dirname, './shared'),
			'@server': path.resolve(__dirname, './worker'),
			'node:fs/promises': 'worker-fs-mount/fs',
			'esbuild-wasm': 'esbuild-wasm/lib/browser.js',
		},
	},
	build: {
		sourcemap: true,
		rollupOptions: {
			output: {
				manualChunks: {
					// CodeMirror core + extensions (~350KB)
					codemirror: [
						'@codemirror/autocomplete',
						'@codemirror/commands',
						'@codemirror/lang-css',
						'@codemirror/lang-html',
						'@codemirror/lang-javascript',
						'@codemirror/lang-json',
						'@codemirror/language',
						'@codemirror/lint',
						'@codemirror/search',
						'@codemirror/state',
						'@codemirror/view',
						'@lezer/common',
						'@lezer/highlight',
						'@lezer/javascript',
						'@lezer/css',
						'@lezer/html',
						'@lezer/json',
					],
					// React ecosystem (~200KB)
					react: ['react', 'react-dom', 'react/jsx-runtime', 'scheduler'],
					// UI libraries (~100KB)
					ui: ['radix-ui', 'class-variance-authority', 'clsx', 'tailwind-merge', 'lucide-react'],
					// Data layer (~50KB)
					data: ['@tanstack/react-query', 'zustand', 'hono/client'],
				},
			},
		},
	},
	server: {
		port: 3000,
		hmr: {
			protocol: 'ws',
			host: 'localhost',
		},
	},
});
