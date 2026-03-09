/**
 * Preview Service.
 * Handles serving and executing user project files in the preview iframe.
 */

import fs from 'node:fs/promises';

import { source as chobitsuSource, hash as chobitsuHash } from 'chobitsu?raw-minified';
import { env, exports } from 'cloudflare:workers';

import { HIDDEN_ENTRIES } from '@shared/constants';
import { resolveAssetSettings } from '@shared/types';

import { getCachedBundle, putCachedBundle } from './bundle-cache-service';
import { bundleWithCdn, BundleDependencyError } from './bundler-service';
import { parseDependencyErrorsFromMessage } from './dependency-error-parser';
import { transformModule, processHTML, toEsbuildTsconfigRaw, type FileSystem } from './transform-service';
import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { source as chobitsuInitSource, hash as chobitsuInitHash } from '../lib/preview-scripts/chobitsu-init.js?raw-minified';
import { source as errorOverlaySource, hash as errorOverlayHash } from '../lib/preview-scripts/error-overlay.js?raw-minified';
import { source as fetchInterceptorSource, hash as fetchInterceptorHash } from '../lib/preview-scripts/fetch-interceptor.js?raw-minified';
import { source as hmrClientSource, hash as hmrClientHash } from '../lib/preview-scripts/hmr-client.js?raw-minified';
import {
	source as reactRefreshPreambleSource,
	hash as reactRefreshPreambleHash,
} from '../lib/preview-scripts/react-refresh-preamble.js?raw-minified';

import type { ResolvedAssetSettings, ServerError } from '@shared/types';
import type { ServerMessage } from '@shared/ws-messages';

// Content-Security-Policy for preview HTML responses.
// Even though the iframe has sandbox="allow-scripts allow-same-origin", which
// technically allows sandbox escape, CSP headers on the *response* cannot be
// removed by JavaScript. This ensures the preview page remains restricted even
// if script code attempts to remove the sandbox attribute from the iframe element.
const PREVIEW_CSP = [
	// Only allow scripts from the same origin (preview route) and inline scripts
	// (needed for the injected HMR config). Block eval() and external scripts.
	"script-src 'self' 'unsafe-inline'",
	// Only allow styles from same origin and inline styles (user CSS, error overlay)
	"style-src 'self' 'unsafe-inline'",
	// Allow images/media/fonts from anywhere (user projects may reference CDNs)
	'img-src * data: blob:',
	'media-src * data: blob:',
	'font-src * data:',
	// Allow fetch/XHR to same origin (preview API) and WebSocket for HMR
	"connect-src 'self' ws: wss:",
	// Prevent the preview from framing other pages
	"frame-src 'none'",
	// Prevent the preview from being embedded outside this app
	"frame-ancestors 'self'",
	// Block all object/embed
	"object-src 'none'",
	// Restrict form submissions to same origin
	"form-action 'self'",
	// Restrict base-uri to prevent base tag hijacking
	"base-uri 'self'",
].join('; ');

const scriptIntegrityHashes: Record<string, string> = {
	'__chobitsu.js': chobitsuHash,
	'__chobitsu-init.js': chobitsuInitHash,
	'__error-overlay.js': errorOverlayHash,
	'__fetch-interceptor.js': fetchInterceptorHash,
	'__hmr-client.js': hmrClientHash,
	'__react-refresh-preamble.js': reactRefreshPreambleHash,
};

// =============================================================================
// Preview Service
// =============================================================================

export class PreviewService {
	constructor(
		private projectRoot: string,
		private projectId: string,
	) {}

	/**
	 * Load asset settings from .project-meta.json.
	 */
	async loadAssetSettings(): Promise<ResolvedAssetSettings> {
		try {
			const raw = await fs.readFile(`${this.projectRoot}/.project-meta.json`, 'utf8');
			const meta = JSON.parse(raw);
			return resolveAssetSettings(meta.assetSettings);
		} catch {
			return resolveAssetSettings();
		}
	}

	/**
	 * Check if a request path matches the run_worker_first configuration.
	 * Supports boolean values and arrays of glob patterns (with ! negation prefix).
	 */
	matchesRunWorkerFirst(pathname: string, runWorkerFirst: boolean | string[]): boolean {
		if (runWorkerFirst === false) {
			return false;
		}
		if (runWorkerFirst === true) {
			return true;
		}
		// Array of patterns: non-negative patterns match, negative patterns (!) exclude
		const positivePatterns = runWorkerFirst.filter((p) => !p.startsWith('!'));
		const negativePatterns = runWorkerFirst.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

		// Negative patterns take precedence: if any negative matches, do NOT run worker first
		for (const pattern of negativePatterns) {
			if (this.matchRoutePattern(pathname, pattern)) {
				return false;
			}
		}
		// If any positive pattern matches, run worker first
		for (const pattern of positivePatterns) {
			if (this.matchRoutePattern(pathname, pattern)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Match a pathname against a route pattern with glob support.
	 * Patterns like /api/* match /api/foo, /api/foo/bar, etc.
	 */
	private matchRoutePattern(pathname: string, pattern: string): boolean {
		// Convert route pattern to regex:
		// 1. Escape all regex-special characters except *
		// 2. Replace * with .* to match any sequence of characters including /
		const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);
		const regexString = '^' + escaped.replaceAll('*', '.*') + '$';
		return new RegExp(regexString).test(pathname);
	}

	/**
	 * Serve a file from the project for preview.
	 */
	async serveFile(request: Request, baseUrl: string, preloadedAssetSettings?: ResolvedAssetSettings): Promise<Response> {
		const url = new URL(request.url);
		let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

		// Serve internal preview scripts (same-origin, avoids CDN issues in sandboxed iframes)
		const internalScripts: Record<string, string> = {
			'/__chobitsu.js': chobitsuSource,
			'/__chobitsu-init.js': chobitsuInitSource,
			'/__error-overlay.js': errorOverlaySource,
			'/__hmr-client.js': hmrClientSource,
			'/__fetch-interceptor.js': fetchInterceptorSource,
			'/__react-refresh-preamble.js': reactRefreshPreambleSource,
		};
		// Strip query params for internal script lookup (cache-buster ?v=... in URL)
		const scriptLookupPath = filePath.split('?')[0];
		const internalScript = internalScripts[scriptLookupPath];
		if (internalScript !== undefined) {
			return new Response(internalScript, {
				headers: {
					'Content-Type': 'application/javascript',
					'Cache-Control': 'public, max-age=31536000, immutable',
				},
			});
		}
		if (filePath === '/chobitsu.js.map') {
			return new Response(undefined, { status: 204 });
		}

		// Check for raw query param (used by HMR for CSS hot-swap)
		const isRawRequest = url.searchParams.has('raw');

		// Check the Accept header to determine if the browser expects CSS
		// (e.g. <link rel="stylesheet"> sends Accept: text/css).
		// This distinguishes between CSS loaded via <link> tags (wants raw CSS)
		// and CSS imported from JS (wants the JS wrapper that injects <style>).
		const acceptHeader = request.headers.get('Accept') || '';
		const isCssAccept = acceptHeader.includes('text/css');

		// Strip query params for file lookup
		filePath = filePath.split('?')[0];

		// Use preloaded asset settings if provided, otherwise load from disk
		const assetSettings = preloadedAssetSettings ?? (await this.loadAssetSettings());

		// Handle html_handling redirects before file resolution
		const htmlHandlingRedirect = await this.handleHtmlRedirects(url, filePath, baseUrl, assetSettings.html_handling);
		if (htmlHandlingRedirect) {
			return htmlHandlingRedirect;
		}

		// Create filesystem adapter
		const viteFs: FileSystem = {
			readFile: (path: string) => fs.readFile(path),
			access: (path: string) => fs.access(path),
		};

		try {
			// Resolve extensionless imports
			let fullPath = `${this.projectRoot}${filePath}`;
			const initialExtension = this.getExtension(filePath);

			if (!initialExtension) {
				const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts'];
				let resolved = false;

				const directResults = await Promise.allSettled(
					extensions.map((tryExtension) => fs.access(fullPath + tryExtension).then(() => tryExtension)),
				);
				for (const result of directResults) {
					if (result.status === 'fulfilled') {
						fullPath = fullPath + result.value;
						filePath = filePath + result.value;
						resolved = true;
						break;
					}
				}

				if (!resolved) {
					const indexResults = await Promise.allSettled(
						extensions.map((tryExtension) => fs.access(fullPath + '/index' + tryExtension).then(() => tryExtension)),
					);
					for (const result of indexResults) {
						if (result.status === 'fulfilled') {
							fullPath = fullPath + '/index' + result.value;
							filePath = filePath + '/index' + result.value;
							resolved = true;
							break;
						}
					}
				}

				if (!resolved) {
					throw new Error(`ENOENT: no such file or directory, '${filePath}'`);
				}
			}

			const content = await fs.readFile(fullPath);
			const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
			const extension = this.getExtension(filePath);

			// Handle HTML files
			if (extension === '.html') {
				return this.serveHtmlFile(textContent, filePath, url, baseUrl, viteFs);
			}

			// Serve raw CSS when:
			// 1. ?raw query param is present (used by HMR client for hot-swap)
			// 2. Accept header includes text/css (browser <link rel="stylesheet"> request)
			if (extension === '.css' && (isRawRequest || isCssAccept)) {
				return new Response(textContent, {
					headers: {
						'Content-Type': 'text/css',
						'Cache-Control': 'no-cache',
					},
				});
			}

			// Handle JS/TS/JSX/TSX - bundle with esm.sh CDN resolution
			if (['.ts', '.tsx', '.jsx', '.js', '.mjs', '.mts'].includes(extension)) {
				const sourceFiles = await this.collectFilesForBundle(`${this.projectRoot}/src`, 'src');
				// Also include root-level files (e.g. tsconfig.json for jsx settings)
				const allFiles: Record<string, string> = { ...sourceFiles };
				// Add the requested file if not already in src/
				const relativeFilePath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
				if (!(relativeFilePath in allFiles)) {
					allFiles[relativeFilePath] = textContent;
				}

				const tsconfigRaw = await this.loadTsconfigRaw();
				const knownDependencies = await this.loadKnownDependencies();

				// Check the Workers Cache API for a previously built bundle
				// with the same content hash (source files + dependencies + tsconfig).
				const cached = await getCachedBundle(allFiles, relativeFilePath, knownDependencies, tsconfigRaw);
				if (cached !== undefined) {
					return new Response(cached, {
						headers: {
							'Content-Type': 'application/javascript',
							'Cache-Control': 'no-cache',
						},
					});
				}

				const bundled = await bundleWithCdn({
					files: allFiles,
					entryPoint: relativeFilePath,
					platform: 'browser',
					tsconfigRaw,
					knownDependencies,
					// Enable React Fast Refresh for browser bundles.
					// This injects $RefreshReg$ registration wrappers around each
					// user module so the refresh runtime can track component families
					// and perform state-preserving hot updates.
					reactRefresh: true,
				});

				// Store the bundle in the Workers Cache API so subsequent
				// requests with identical inputs skip the esbuild step.
				putCachedBundle(allFiles, relativeFilePath, knownDependencies, tsconfigRaw, bundled.code);

				return new Response(bundled.code, {
					headers: {
						'Content-Type': 'application/javascript',
						'Cache-Control': 'no-cache',
					},
				});
			}

			// Handle CSS/JSON - use transformModule for import rewriting
			const transformed = await transformModule(filePath, textContent, {
				fs: viteFs,
				projectRoot: this.projectRoot,
				baseUrl,
			});

			return new Response(transformed.code, {
				headers: {
					'Content-Type': transformed.contentType,
					'Cache-Control': 'no-cache',
				},
			});
		} catch (error) {
			// Apply not_found_handling fallback for ENOENT errors
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (errorMessage.includes('ENOENT')) {
				const fallbackResponse = await this.handleNotFoundFallback(url, baseUrl, assetSettings.not_found_handling);
				if (fallbackResponse) {
					return fallbackResponse;
				}
			}

			console.error('serveFile error:', error);
			const locMatch = errorMessage.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);
			const serverError: ServerError = {
				id: crypto.randomUUID(),
				timestamp: Date.now(),
				type: 'bundle',
				message: errorMessage,
				file: locMatch ? locMatch[1] : undefined,
				line: locMatch ? Number(locMatch[2]) : undefined,
				column: locMatch ? Number(locMatch[3]) : undefined,
				dependencyErrors:
					(error instanceof BundleDependencyError ? error.dependencyErrors : undefined) ?? parseDependencyErrorsFromMessage(errorMessage),
			};
			await this.broadcastError(serverError).catch(() => {});
			const errorJson = JSON.stringify(serverError)
				.replaceAll('<', String.raw`\u003c`)
				.replaceAll('>', String.raw`\u003e`);
			const errorModule = `if(typeof showErrorOverlay==='function'){showErrorOverlay(${errorJson})}else{console.error(${errorJson}.message)}`;
			return new Response(errorModule, {
				headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
			});
		}
	}

	/**
	 * Serve an HTML file with preview scripts injected.
	 */
	private async serveHtmlFile(textContent: string, filePath: string, url: URL, baseUrl: string, viteFs: FileSystem): Promise<Response> {
		const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		const projectPrefix = baseUrl.replace(/\/preview\/?$/, '');
		const wsUrl = `${protocol}//${url.host}${projectPrefix}/__ws`;
		const html = await processHTML(textContent, filePath, {
			fs: viteFs,
			projectRoot: this.projectRoot,
			baseUrl,
			wsUrl,
			scriptIntegrityHashes,
		});
		return new Response(html, {
			headers: {
				'Content-Type': 'text/html',
				'Cache-Control': 'no-cache',
				'Content-Security-Policy': PREVIEW_CSP,
			},
		});
	}

	/**
	 * Handle not_found_handling fallback when a file is not found.
	 *
	 * - "single-page-application": Serve /index.html with 200
	 * - "404-page": Serve the nearest 404.html with 404 status
	 * - "none" (default): Return undefined to let the normal error handling take over
	 */
	private async handleNotFoundFallback(url: URL, baseUrl: string, notFoundHandling: string | undefined): Promise<Response | undefined> {
		const viteFs: FileSystem = {
			readFile: (path: string) => fs.readFile(path),
			access: (path: string) => fs.access(path),
		};

		if (notFoundHandling === 'single-page-application') {
			try {
				const indexPath = `${this.projectRoot}/index.html`;
				const content = await fs.readFile(indexPath);
				const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
				const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
				const projectPrefix = baseUrl.replace(/\/preview\/?$/, '');
				const wsUrl = `${protocol}//${url.host}${projectPrefix}/__ws`;
				const html = await processHTML(textContent, '/index.html', {
					fs: viteFs,
					projectRoot: this.projectRoot,
					baseUrl,
					wsUrl,
					scriptIntegrityHashes,
				});
				return new Response(html, {
					headers: {
						'Content-Type': 'text/html',
						'Cache-Control': 'no-cache',
						'Content-Security-Policy': PREVIEW_CSP,
					},
				});
			} catch {
				// index.html not found — fall through to error
				return undefined;
			}
		}

		if (notFoundHandling === '404-page') {
			// Search for the nearest 404.html starting from the requested path
			const pathname = url.pathname;
			const segments = pathname.split('/').filter(Boolean);

			// Try progressively higher directories: /foo/bar/404.html, /foo/404.html, /404.html
			for (let index = segments.length; index >= 0; index--) {
				const directory = index === 0 ? '' : '/' + segments.slice(0, index).join('/');
				const notFoundPath = `${this.projectRoot}${directory}/404.html`;
				try {
					const content = await fs.readFile(notFoundPath);
					const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
					const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
					const projectPrefix = baseUrl.replace(/\/preview\/?$/, '');
					const wsUrl = `${protocol}//${url.host}${projectPrefix}/__ws`;
					const html = await processHTML(textContent, `${directory}/404.html`, {
						fs: viteFs,
						projectRoot: this.projectRoot,
						baseUrl,
						wsUrl,
						scriptIntegrityHashes,
					});
					return new Response(html, {
						status: 404,
						headers: {
							'Content-Type': 'text/html',
							'Cache-Control': 'no-cache',
							'Content-Security-Policy': PREVIEW_CSP,
						},
					});
				} catch {
					// 404.html not found at this level, try parent
				}
			}
			return undefined;
		}

		// "none" or unset — no fallback
		return undefined;
	}

	/**
	 * Handle html_handling redirects for HTML content requests.
	 *
	 * - "auto-trailing-slash" (default): Redirect /foo → /foo/ if foo/index.html exists,
	 *   redirect /foo/ �� /foo if foo.html exists (and foo/index.html does not).
	 * - "force-trailing-slash": Always redirect to trailing slash for HTML pages.
	 * - "drop-trailing-slash": Always redirect to remove trailing slash for HTML pages.
	 * - "none": No redirects.
	 */
	private async handleHtmlRedirects(
		url: URL,
		filePath: string,
		baseUrl: string,
		htmlHandling = 'auto-trailing-slash',
	): Promise<Response | undefined> {
		if (htmlHandling === 'none') {
			return undefined;
		}

		// Only process paths without file extensions (potential HTML routes)
		const extension = this.getExtension(filePath);
		if (extension && extension !== '.html') {
			return undefined;
		}

		const pathname = filePath;
		const hasTrailingSlash = pathname.endsWith('/') && pathname !== '/';

		if (htmlHandling === 'force-trailing-slash') {
			if (!hasTrailingSlash && pathname !== '/') {
				// Check if there's an index.html in a directory with this name
				try {
					await fs.access(`${this.projectRoot}${pathname}/index.html`);
					const redirectUrl = new URL(url);
					redirectUrl.pathname = `${baseUrl}${pathname}/`;
					return Response.redirect(redirectUrl.toString(), 308);
				} catch {
					// No directory/index.html — no redirect needed
				}
			}
			return undefined;
		}

		if (htmlHandling === 'drop-trailing-slash') {
			if (hasTrailingSlash) {
				const withoutSlash = pathname.slice(0, -1);
				// Check if there's a direct .html file
				try {
					await fs.access(`${this.projectRoot}${withoutSlash}.html`);
					const redirectUrl = new URL(url);
					redirectUrl.pathname = `${baseUrl}${withoutSlash}`;
					return Response.redirect(redirectUrl.toString(), 308);
				} catch {
					// No .html file — no redirect needed
				}
			}
			return undefined;
		}

		// "auto-trailing-slash" (default)
		if (!hasTrailingSlash && pathname !== '/') {
			// /foo → /foo/ if foo/index.html exists
			try {
				await fs.access(`${this.projectRoot}${pathname}/index.html`);
				const redirectUrl = new URL(url);
				redirectUrl.pathname = `${baseUrl}${pathname}/`;
				return Response.redirect(redirectUrl.toString(), 308);
			} catch {
				// No directory/index.html
			}
		} else if (hasTrailingSlash) {
			// /foo/ → /foo if foo.html exists and foo/index.html does NOT exist
			const withoutSlash = pathname.slice(0, -1);
			let hasIndexHtml = false;
			try {
				await fs.access(`${this.projectRoot}${pathname}index.html`);
				hasIndexHtml = true;
			} catch {
				// No index.html in directory
			}
			if (!hasIndexHtml) {
				try {
					await fs.access(`${this.projectRoot}${withoutSlash}.html`);
					const redirectUrl = new URL(url);
					redirectUrl.pathname = `${baseUrl}${withoutSlash}`;
					return Response.redirect(redirectUrl.toString(), 308);
				} catch {
					// No .html file either
				}
			}
		}

		return undefined;
	}

	/**
	 * Handle preview API routes (user's backend code).
	 */
	async handlePreviewAPI(request: Request, apiPath: string): Promise<Response> {
		try {
			const files = await this.collectFilesForBundle(`${this.projectRoot}/worker`, 'worker');

			const workerEntry = Object.keys(files).find((f) => f === 'worker/index.ts' || f === 'worker/index.js');

			if (!workerEntry) {
				const error: ServerError = {
					id: crypto.randomUUID(),
					timestamp: Date.now(),
					type: 'bundle',
					message: 'No worker/index.ts found. Create a worker/index.ts file with a default export { fetch }.',
				};
				await this.broadcastError(error).catch(() => {});
				return Response.json({ error: error.message, serverError: error }, { status: 500 });
			}

			const workerFiles = Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b));
			const knownDependencies = await this.loadKnownDependencies();
			const contentHash = await this.hashContent(JSON.stringify(workerFiles) + JSON.stringify([...knownDependencies.entries()]));

			// Create a tail consumer to capture console.log output from the sandbox
			const logTailer = exports.LogTailer({ props: { projectId: this.projectId } });

			const worker = env.LOADER.get(`worker:${contentHash}`, async () => {
				const tsconfigRaw = await this.loadTsconfigRaw();

				const bundled = await bundleWithCdn({
					files,
					entryPoint: workerEntry,
					platform: 'neutral',
					tsconfigRaw,
					knownDependencies,
				});

				return {
					compatibilityDate: '2026-01-31',
					mainModule: 'worker.js',
					modules: { 'worker.js': bundled.code },
					tails: [logTailer],
				};
			});

			// Create request with correct path
			const apiUrl = new URL(request.url);
			apiUrl.pathname = apiPath;
			const apiRequest = new Request(apiUrl.toString(), request);

			const entrypoint = worker.getEntrypoint();
			const response = await entrypoint.fetch(apiRequest);

			return response;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isBundleError = errorMessage.includes('ERROR:');
			const locMatch = errorMessage.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);
			let file = locMatch ? locMatch[1] : undefined;
			let line = locMatch ? Number(locMatch[2]) : undefined;
			// esbuild columns are 0-indexed; convert to 1-indexed
			let column = locMatch ? Number(locMatch[3]) + 1 : undefined;

			if (!file && error instanceof Error && error.stack) {
				const stackLines = error.stack.split('\n');
				for (const stackLine of stackLines) {
					const m = stackLine.match(/at\s+.*?\(?([\w./-]+\.(?:js|ts|mjs|tsx|jsx)):(\d+):(\d+)\)?/);
					if (m && /^worker\//.test(m[1])) {
						file = m[1];
						// V8 stack traces are already 1-indexed
						line = Number(m[2]);
						column = Number(m[3]);
						break;
					}
				}
			}

			const serverError: ServerError = {
				id: crypto.randomUUID(),
				timestamp: Date.now(),
				type: isBundleError ? 'bundle' : 'runtime',
				message: errorMessage,
				file,
				line,
				column,
				dependencyErrors:
					(error instanceof BundleDependencyError ? error.dependencyErrors : undefined) ?? parseDependencyErrorsFromMessage(errorMessage),
			};

			await this.broadcastError(serverError).catch(() => {});
			console.error('Server code execution error:', error);
			return Response.json({ error: errorMessage, serverError: serverError }, { status: 500 });
		}
	}

	// =============================================================================
	// Private Methods
	// =============================================================================

	private getExtension(path: string): string {
		const match = path.match(/\.[^./]+$/);
		return match ? match[0].toLowerCase() : '';
	}

	/**
	 * Load and convert tsconfig.json to esbuild's tsconfigRaw format.
	 */
	private async loadTsconfigRaw(): Promise<string | undefined> {
		try {
			const content = await fs.readFile(`${this.projectRoot}/tsconfig.json`, 'utf8');
			const tsConfig = JSON.parse(content);
			return toEsbuildTsconfigRaw(tsConfig);
		} catch {
			return undefined;
		}
	}

	/**
	 * Load registered dependencies from .project-meta.json as a Map of name → version.
	 */
	private async loadKnownDependencies(): Promise<Map<string, string>> {
		try {
			const raw = await fs.readFile(`${this.projectRoot}/.project-meta.json`, 'utf8');
			const meta = JSON.parse(raw);
			if (meta.dependencies && typeof meta.dependencies === 'object') {
				return new Map(Object.entries(meta.dependencies));
			}
		} catch {
			// No meta file or parse error
		}
		return new Map();
	}

	private async broadcastError(error: ServerError): Promise<void> {
		await this.broadcastMessage({ type: 'server-error', error });
	}

	private async broadcastMessage(message: ServerMessage): Promise<void> {
		const coordinatorId = coordinatorNamespace.idFromName(`project:${this.projectId}`);
		const coordinatorStub = coordinatorNamespace.get(coordinatorId);
		await coordinatorStub.sendMessage(message);
	}

	private async hashContent(content: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(content);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = [...new Uint8Array(hashBuffer)];
		return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	}

	private async collectFilesForBundle(directory: string, base = ''): Promise<Record<string, string>> {
		const files: Record<string, string> = {};
		try {
			const entries = await fs.readdir(directory, { withFileTypes: true });
			const results = await Promise.all(
				entries
					.filter((entry: { name: string }) => !HIDDEN_ENTRIES.has(entry.name))
					.map(async (entry: { name: string; isDirectory(): boolean }) => {
						const relativePath = base ? `${base}/${entry.name}` : entry.name;
						const fullPath = `${directory}/${entry.name}`;
						if (entry.isDirectory()) {
							return this.collectFilesForBundle(fullPath, relativePath);
						} else {
							const content = await fs.readFile(fullPath, 'utf8');
							return { [relativePath]: content };
						}
					}),
			);
			for (const result of results) {
				Object.assign(files, result);
			}
		} catch (error) {
			if (base === '') {
				console.error('collectFilesForBundle error:', error);
			}
		}
		return files;
	}
}
