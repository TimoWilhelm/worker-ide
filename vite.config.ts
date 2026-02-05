import { defineConfig, Plugin } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function esbuildWasmPlugin(): Plugin {
	return {
		name: 'esbuild-wasm-plugin',
		buildStart() {
			const wasmSource = join(__dirname, 'node_modules/esbuild-wasm/esbuild.wasm');
			const vendorDir = join(__dirname, 'vendor');
			const wasmDest = join(vendorDir, 'esbuild.wasm');
			if (existsSync(wasmSource) && !existsSync(wasmDest)) {
				mkdirSync(vendorDir, { recursive: true });
				copyFileSync(wasmSource, wasmDest);
			}
		},
	};
}

export default defineConfig({
	plugins: [
		esbuildWasmPlugin(),
		cloudflare({
			configPath: './wrangler.jsonc',
		}),
	],
	resolve: {
		alias: {
			'node:fs/promises': 'worker-fs-mount/fs',
			'esbuild-wasm': 'esbuild-wasm/lib/browser.js',
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
