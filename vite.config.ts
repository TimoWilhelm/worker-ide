import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, transformWithEsbuild } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { appMetadata } from './shared/app-metadata';
import { DEFAULT_EDITOR_FONT, EDITOR_FONT_FAMILIES } from './shared/constants/editor-fonts';

import type { HtmlTagDescriptor, Plugin, ResolvedConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commitHash = execSync('git rev-parse HEAD').toString().trim();
function applyDefines(code: string, defines: Record<string, string>): string {
	let result = code;
	for (const [token, value] of Object.entries(defines)) {
		result = result.replaceAll(token, value);
	}
	return result;
}
async function minifyAndHash(code: string, filePath: string): Promise<{ source: string; hash: string }> {
	const result = await transformWithEsbuild(code, filePath, {
		minify: true,
		legalComments: 'none',
	});
	const digest = createHash('sha256').update(result.code).digest('base64');
	return { source: result.code, hash: `sha256-${digest}` };
}

/**
 * Import any `.js` file as a minified source string + SRI hash via `?raw-minified`.
 *
 * Supports an optional `define` map for build-time token replacement (applied
 * before minification so that the replaced values are also minified).
 */
function rawMinifiedPlugin(options?: { define?: Record<string, string> }): Plugin {
	const defines = options?.define ?? {};

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

			const raw = applyDefines(readFileSync(filePath, 'utf8'), defines);
			const { source, hash } = await minifyAndHash(raw, filePath);

			return `export const source = ${JSON.stringify(source)};\nexport const hash = ${JSON.stringify(hash)};\nexport default source;`;
		},
	};
}

/**
 * Emit the FOUC-prevention script as an external, render-blocking `<script>` in `<head>`.
 *
 * - **Dev**: serves the token-replaced script at a virtual URL via middleware.
 * - **Build**: minifies, emits as a content-hashed asset with a deterministic
 *   filename, and injects `<script src="/assets/fouc-prevention-<hash>.js">`
 *   into the HTML.
 *
 * Tokens (`__DEFAULT_EDITOR_FONT__`, `__EDITOR_FONT_FAMILIES__`) are replaced
 * with values from `shared/constants/editor-fonts.ts` so that `index.html`
 * never contains hardcoded font definitions.
 */
function foucPreventionPlugin(): Plugin {
	const scriptPath = path.resolve(__dirname, 'src/lib/fouc-prevention.js');
	const virtualUrl = '/@fouc-prevention.js';

	const defines: Record<string, string> = {
		__DEFAULT_EDITOR_FONT__: JSON.stringify(DEFAULT_EDITOR_FONT),
		__EDITOR_FONT_FAMILIES__: JSON.stringify(EDITOR_FONT_FAMILIES),
	};

	let resolvedConfig: ResolvedConfig;
	let assetFileName: string;

	function processScript(): string {
		return applyDefines(readFileSync(scriptPath, 'utf8'), defines);
	}

	return {
		name: 'fouc-prevention',

		configResolved(config) {
			resolvedConfig = config;
		},

		// Dev: serve the processed script at a virtual URL
		configureServer(server) {
			server.middlewares.use(virtualUrl, (_request, response) => {
				response.setHeader('Content-Type', 'application/javascript');
				response.setHeader('Cache-Control', 'no-cache');
				response.end(processScript());
			});
		},

		// Build: emit the minified script as a content-hashed asset.
		// We compute the hash ourselves and use an explicit `fileName` so
		// the value is deterministic and known before transformIndexHtml runs
		// (no reliance on __VITE_ASSET__ placeholder resolution in HTML).
		async buildStart() {
			if (resolvedConfig.command !== 'build') return;
			const { source } = await minifyAndHash(processScript(), scriptPath);
			// Use the first 8 hex chars of a content hash for a deterministic filename.
			const contentHash = createHash('sha256').update(source).digest('hex').slice(0, 8);
			assetFileName = `assets/fouc-prevention-${contentHash}.js`;
			this.emitFile({
				type: 'asset',
				fileName: assetFileName,
				source,
			});
		},

		// Inject a render-blocking <script src="..."> at the top of <head>
		transformIndexHtml() {
			const source = resolvedConfig.command === 'serve' ? virtualUrl : `/${assetFileName}`;
			return [{ tag: 'script', attrs: { src: source }, injectTo: 'head-prepend' }];
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

function createAppHeadTags(): HtmlTagDescriptor[] {
	const socialImage = appMetadata.socialImage;

	return [
		{ tag: 'title', children: appMetadata.title, injectTo: 'head' },
		{ tag: 'link', attrs: { rel: 'canonical', href: appMetadata.canonicalUrl }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'viewport', content: appMetadata.viewport }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'description', content: appMetadata.description }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'robots', content: appMetadata.robots }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'googlebot', content: appMetadata.googlebot }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'theme-color', content: appMetadata.themeColor }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'application-name', content: appMetadata.applicationName }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: appMetadata.appleMobileWebAppTitle }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'format-detection', content: appMetadata.formatDetection }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:type', content: 'website' }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:url', content: appMetadata.canonicalUrl }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:title', content: appMetadata.socialTitle }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:description', content: appMetadata.socialDescription }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:image', content: socialImage.absoluteUrl }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:image:secure_url', content: socialImage.absoluteUrl }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:image:type', content: socialImage.type }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:image:width', content: String(socialImage.width) }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:image:height', content: String(socialImage.height) }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:image:alt', content: socialImage.alt }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:site_name', content: appMetadata.productName }, injectTo: 'head' },
		{ tag: 'meta', attrs: { property: 'og:locale', content: appMetadata.locale }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'twitter:card', content: appMetadata.twitterCard }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'twitter:title', content: appMetadata.socialTitle }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'twitter:description', content: appMetadata.socialDescription }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'twitter:image', content: socialImage.absoluteUrl }, injectTo: 'head' },
		{ tag: 'meta', attrs: { name: 'twitter:image:alt', content: socialImage.alt }, injectTo: 'head' },
	];
}

function appMetadataPlugin(): Plugin {
	return {
		name: 'app-metadata',
		transformIndexHtml() {
			return createAppHeadTags();
		},
	};
}

export default defineConfig({
	plugins: [
		rawMinifiedPlugin(),
		foucPreventionPlugin(),
		appMetadataPlugin(),
		biomeWasmNoopPlugin(),
		tailwindcss(),
		react(),
		cloudflare({
			configPath: './wrangler.jsonc',
			auxiliaryWorkers: [
				{ configPath: './auxiliary/biome/wrangler.jsonc' },
				{ configPath: './auxiliary/esbuild/wrangler.jsonc' },
				{ configPath: './auxiliary/git/wrangler.jsonc' },
				{ configPath: './auxiliary/push/wrangler.jsonc' },
				{ configPath: './auxiliary/email/wrangler.jsonc' },
			],
		}),
		VitePWA({
			registerType: 'prompt',
			manifest: appMetadata.manifest,
			workbox: {
				navigateFallback: '/index.html',
				navigateFallbackDenylist: [/^\/api\//, /^\/p\//, /^\/docs/],
				globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
				runtimeCaching: [
					{
						urlPattern: ({ sameOrigin, url }) =>
							sameOrigin &&
							!url.pathname.startsWith('/api/') &&
							!url.pathname.startsWith('/p/') &&
							!url.pathname.startsWith('/docs') &&
							!/\.[^/]+$/.test(url.pathname),
						handler: 'NetworkFirst',
						options: {
							cacheName: 'app-shell',
							networkTimeoutSeconds: 3,
							cacheableResponse: {
								statuses: [200],
							},
						},
					},
				],
				importScripts: ['/push-sw.js'],
			},
			devOptions: {
				enabled: true,
			},
		}),
	],
	define: {
		__APP_VERSION__: JSON.stringify(commitHash),
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
			'@shared': path.resolve(__dirname, './shared'),
			'@server': path.resolve(__dirname, './worker'),
			'@worker': path.resolve(__dirname, './worker'),
			'@git': path.resolve(__dirname, './auxiliary/git'),
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
					ui: ['@base-ui/react', 'class-variance-authority', 'clsx', 'tailwind-merge', 'lucide-react'],
					// Data layer (~50KB)
					data: ['@tanstack/react-query', 'zustand', 'hono/client'],
				},
			},
		},
	},
	esbuild: {
		supported: {
			decorators: false,
		},
	},
	server: {
		port: 3000,
		// Allow all localhost subdomains (*.preview.localhost, etc.)
		allowedHosts: ['.localhost'],
	},
});
