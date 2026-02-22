import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, transformWithEsbuild } from 'vite';

import type { Plugin } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function rawMinifiedPlugin(): Plugin {
	return {
		name: 'raw-minified',
		enforce: 'pre',
		async resolveId(source, importer) {
			if (!source.endsWith('?raw-minified')) return;
			const rawPath = source.slice(0, -'?raw-minified'.length);

			if (rawPath.startsWith('.') || path.isAbsolute(rawPath)) {
				const resolved = importer ? path.resolve(path.dirname(importer), rawPath) : rawPath;
				return resolved + '?raw-minified';
			}

			// Bare module specifier — resolve via import.meta.resolve to avoid Vite's dep optimizer
			const resolved = await import.meta.resolve(rawPath);
			return fileURLToPath(resolved) + '?raw-minified';
		},
		async load(id) {
			if (!id.endsWith('?raw-minified')) return;
			const filePath = id.slice(0, -'?raw-minified'.length);

			const raw = readFileSync(filePath, 'utf8');
			const result = await transformWithEsbuild(raw, filePath, {
				minify: true,
				legalComments: 'none',
			});

			const minified = result.code;
			const digest = createHash('sha256').update(minified).digest('base64');
			const hash = `sha256-${digest}`;

			return `export const source = ${JSON.stringify(minified)};\nexport const hash = ${JSON.stringify(hash)};\nexport default source;`;
		},
	};
}

/**
 * Prevent Vite from statically detecting `new URL('biome_wasm_bg.wasm', import.meta.url)`
 * in @biomejs/wasm-web and trying to emit the WASM as a bundled asset.
 *
 * Both client and server now pass the WASM module explicitly to the init function,
 * so this default URL inside @biomejs/wasm-web is never used. We replace it with a
 * no-op URL to stop Vite's asset pipeline from processing the original 27+ MiB file.
 *
 * The optimized WASM lives in vendor/biome_wasm_bg.wasm (created by scripts/vendor-wasm.ts).
 */
function biomeWasmNoopPlugin(): Plugin {
	return {
		name: 'biome-wasm-noop',
		enforce: 'pre',
		transform(code, id) {
			if (!id.includes('@biomejs/wasm-web')) return;
			return code.replace(`new URL('biome_wasm_bg.wasm', import.meta.url)`, `new URL('about:blank')`);
		},
	};
}

export default defineConfig({
	plugins: [
		rawMinifiedPlugin(),
		biomeWasmNoopPlugin(),
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
	optimizeDeps: {
		exclude: ['@biomejs/wasm-web'],
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
