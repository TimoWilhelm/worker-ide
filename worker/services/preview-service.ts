/**
 * Preview Service.
 *
 * Serves user project files on the preview subdomain.
 * Each preview lives on its own origin — request paths map directly to the filesystem.
 */

import fs from 'node:fs/promises';

import { source as chobitsuSource, hash as chobitsuHash } from 'chobitsu?raw-minified';
import { env, exports } from 'cloudflare:workers';
import stripJsonComments from 'strip-json-comments';

import { HIDDEN_ENTRIES } from '@shared/constants';
import { resolveAssetSettings } from '@shared/types';

import { bundleFiles } from './bundle-service';
import { BundleDependencyError } from './bundler-client';
import { parseDependencyErrorsFromMessage } from './dependency-error-parser';
import { transformModule, processHTML, toEsbuildTsconfigRaw, type FileSystem } from './transform-service';
import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { source as chobitsuInitSource, hash as chobitsuInitHash } from '../lib/preview-scripts/chobitsu-init.js?raw-minified';
import { source as errorOverlaySource, hash as errorOverlayHash } from '../lib/preview-scripts/error-overlay.js?raw-minified';
import { source as hmrClientSource, hash as hmrClientHash } from '../lib/preview-scripts/hmr-client.js?raw-minified';
import {
	source as reactRefreshPreambleSource,
	hash as reactRefreshPreambleHash,
} from '../lib/preview-scripts/react-refresh-preamble.js?raw-minified';

import type { ResolvedAssetSettings, ServerError } from '@shared/types';
import type { ServerMessage } from '@shared/ws-messages';

// =============================================================================
// Content-Security-Policy
// =============================================================================

/**
 * Build the CSP header for preview HTML responses.
 *
 * The preview runs on a separate origin from the IDE, so `frame-ancestors`
 * is set to the IDE origin to prevent embedding by arbitrary sites.
 */
function buildPreviewCsp(ideOrigin: string): string {
	return [
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		'img-src * data: blob:',
		'media-src * data: blob:',
		'font-src * data:',
		"connect-src 'self' ws: wss:",
		"frame-src 'none'",
		`frame-ancestors ${ideOrigin}`,
		"object-src 'none'",
		"form-action 'self'",
		"base-uri 'self'",
	].join('; ');
}

// =============================================================================
// Script Integrity Hashes
// =============================================================================

const scriptIntegrityHashes: Record<string, string> = {
	'__chobitsu.js': chobitsuHash,
	'__chobitsu-init.js': chobitsuInitHash,
	'__error-overlay.js': errorOverlayHash,
	'__hmr-client.js': hmrClientHash,
	'__react-refresh-preamble.js': reactRefreshPreambleHash,
};

// =============================================================================
// Internal Preview Scripts
// =============================================================================

const INTERNAL_SCRIPTS: Record<string, string> = {
	'/__chobitsu.js': chobitsuSource,
	'/__chobitsu-init.js': chobitsuInitSource,
	'/__error-overlay.js': errorOverlaySource,
	'/__hmr-client.js': hmrClientSource,
	'/__react-refresh-preamble.js': reactRefreshPreambleSource,
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
	 */
	matchesRunWorkerFirst(pathname: string, runWorkerFirst: boolean | string[]): boolean {
		if (runWorkerFirst === false) return false;
		if (runWorkerFirst === true) return true;

		const positivePatterns = runWorkerFirst.filter((p) => !p.startsWith('!'));
		const negativePatterns = runWorkerFirst.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

		for (const pattern of negativePatterns) {
			if (this.matchRoutePattern(pathname, pattern)) return false;
		}
		for (const pattern of positivePatterns) {
			if (this.matchRoutePattern(pathname, pattern)) return true;
		}
		return false;
	}

	/**
	 * Serve a file from the project for preview.
	 *
	 * @param request - The incoming request (URL path maps directly to project files)
	 * @param ideOrigin - The IDE app's origin for CSP and postMessage targeting
	 * @param preloadedAssetSettings - Pre-loaded asset settings to avoid duplicate reads
	 */
	async serveFile(request: Request, ideOrigin: string, preloadedAssetSettings?: ResolvedAssetSettings): Promise<Response> {
		const url = new URL(request.url);
		let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

		// Serve internal preview scripts
		const scriptLookupPath = filePath.split('?')[0];
		const internalScript = INTERNAL_SCRIPTS[scriptLookupPath];
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

		const isRawRequest = url.searchParams.has('raw');
		const acceptHeader = request.headers.get('Accept') || '';
		const isCssAccept = acceptHeader.includes('text/css');

		filePath = filePath.split('?')[0];

		const assetSettings = preloadedAssetSettings ?? (await this.loadAssetSettings());

		const htmlHandlingRedirect = await this.handleHtmlRedirects(url, filePath, assetSettings.html_handling);
		if (htmlHandlingRedirect) {
			return htmlHandlingRedirect;
		}

		const viteFs: FileSystem = {
			readFile: (path: string) => fs.readFile(path),
			access: (path: string) => fs.access(path),
		};

		try {
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

			if (extension === '.html') {
				return this.serveHtmlFile(textContent, filePath, url, ideOrigin, viteFs);
			}

			if (extension === '.css' && (isRawRequest || isCssAccept)) {
				return new Response(textContent, {
					headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' },
				});
			}

			if (['.ts', '.tsx', '.jsx', '.js', '.mjs', '.mts'].includes(extension)) {
				const sourceFiles = await this.collectFilesForBundle(`${this.projectRoot}/src`, 'src');
				const allFiles: Record<string, string> = { ...sourceFiles };
				const relativeFilePath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
				if (!(relativeFilePath in allFiles)) {
					allFiles[relativeFilePath] = textContent;
				}

				const tsconfigRaw = await this.loadTsconfigRaw();
				const knownDependencies = await this.loadKnownDependencies();

				const bundled = await bundleFiles({
					files: allFiles,
					entryPoint: relativeFilePath,
					platform: 'browser',
					tsconfigRaw,
					knownDependencies,
					reactRefresh: true,
				});

				return new Response(bundled.code, {
					headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
				});
			}

			const transformed = await transformModule(filePath, textContent, {
				fs: viteFs,
				projectRoot: this.projectRoot,
			});

			return new Response(transformed.code, {
				headers: { 'Content-Type': transformed.contentType, 'Cache-Control': 'no-cache' },
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (errorMessage.includes('ENOENT')) {
				const fallbackResponse = await this.handleNotFoundFallback(url, ideOrigin, assetSettings.not_found_handling);
				if (fallbackResponse) {
					return fallbackResponse;
				}

				// File genuinely not found and no SPA/404 fallback handled it.
				// Return a plain 404 instead of the JS error overlay.
				return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-cache' } });
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

			const logTailer = exports.LogTailer({ props: { projectId: this.projectId } });

			const worker = env.LOADER.get(`worker:${contentHash}`, async () => {
				const tsconfigRaw = await this.loadTsconfigRaw();

				const bundled = await bundleFiles({
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

			const apiUrl = new URL(request.url);
			apiUrl.pathname = apiPath;
			const apiRequest = new Request(apiUrl.toString(), request);

			const entrypoint = worker.getEntrypoint();
			return await entrypoint.fetch(apiRequest);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isBundleError = errorMessage.includes('ERROR:');
			const locMatch = errorMessage.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);
			let file = locMatch ? locMatch[1] : undefined;
			let line = locMatch ? Number(locMatch[2]) : undefined;
			let column = locMatch ? Number(locMatch[3]) + 1 : undefined;

			if (!file && error instanceof Error && error.stack) {
				const stackLines = error.stack.split('\n');
				for (const stackLine of stackLines) {
					const m = stackLine.match(/at\s+.*?\(?([\w./-]+\.(?:js|ts|mjs|tsx|jsx)):(\d+):(\d+)\)?/);
					if (m && /^worker\//.test(m[1])) {
						file = m[1];
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
			return Response.json({ error: errorMessage, serverError }, { status: 500 });
		}
	}

	// =============================================================================
	// Private Methods
	// =============================================================================

	private matchRoutePattern(pathname: string, pattern: string): boolean {
		const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);
		const regexString = '^' + escaped.replaceAll('*', '.*') + '$';
		return new RegExp(regexString).test(pathname);
	}

	private getExtension(path: string): string {
		const match = path.match(/\.[^./]+$/);
		return match ? match[0].toLowerCase() : '';
	}

	/**
	 * Serve an HTML file with preview scripts injected.
	 */
	private async serveHtmlFile(textContent: string, filePath: string, url: URL, ideOrigin: string, viteFs: FileSystem): Promise<Response> {
		const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		const wsUrl = `${protocol}//${url.host}/__ws`;
		const html = await processHTML(textContent, filePath, {
			fs: viteFs,
			projectRoot: this.projectRoot,
			wsUrl,
			ideOrigin,
			projectId: this.projectId,
			scriptIntegrityHashes,
		});
		return new Response(html, {
			headers: {
				'Content-Type': 'text/html',
				'Cache-Control': 'no-cache',
				'Content-Security-Policy': buildPreviewCsp(ideOrigin),
			},
		});
	}

	/**
	 * Handle not_found_handling fallback when a file is not found.
	 */
	private async handleNotFoundFallback(url: URL, ideOrigin: string, notFoundHandling: string | undefined): Promise<Response | undefined> {
		const viteFs: FileSystem = {
			readFile: (path: string) => fs.readFile(path),
			access: (path: string) => fs.access(path),
		};

		if (notFoundHandling === 'single-page-application') {
			try {
				const indexPath = `${this.projectRoot}/index.html`;
				const content = await fs.readFile(indexPath);
				const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
				return this.serveHtmlFile(textContent, '/index.html', url, ideOrigin, viteFs);
			} catch {
				return undefined;
			}
		}

		if (notFoundHandling === '404-page') {
			const pathname = url.pathname;
			const segments = pathname.split('/').filter(Boolean);

			for (let index = segments.length; index >= 0; index--) {
				const directory = index === 0 ? '' : '/' + segments.slice(0, index).join('/');
				const notFoundPath = `${this.projectRoot}${directory}/404.html`;
				try {
					const content = await fs.readFile(notFoundPath);
					const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
					const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
					const wsUrl = `${protocol}//${url.host}/__ws`;
					const html = await processHTML(textContent, `${directory}/404.html`, {
						fs: viteFs,
						projectRoot: this.projectRoot,
						wsUrl,
						ideOrigin,
						projectId: this.projectId,
						scriptIntegrityHashes,
					});
					return new Response(html, {
						status: 404,
						headers: {
							'Content-Type': 'text/html',
							'Cache-Control': 'no-cache',
							'Content-Security-Policy': buildPreviewCsp(ideOrigin),
						},
					});
				} catch {
					// 404.html not found at this level, try parent
				}
			}
			return undefined;
		}

		return undefined;
	}

	/**
	 * Handle html_handling redirects for HTML content requests.
	 */
	private async handleHtmlRedirects(url: URL, filePath: string, htmlHandling = 'auto-trailing-slash'): Promise<Response | undefined> {
		if (htmlHandling === 'none') {
			return undefined;
		}

		const extension = this.getExtension(filePath);
		if (extension && extension !== '.html') {
			return undefined;
		}

		const pathname = filePath;
		const hasTrailingSlash = pathname.endsWith('/') && pathname !== '/';

		if (htmlHandling === 'force-trailing-slash') {
			if (!hasTrailingSlash && pathname !== '/') {
				try {
					await fs.access(`${this.projectRoot}${pathname}/index.html`);
					const redirectUrl = new URL(url);
					redirectUrl.pathname = `${pathname}/`;
					return Response.redirect(redirectUrl.toString(), 308);
				} catch {
					// No directory/index.html
				}
			}
			return undefined;
		}

		if (htmlHandling === 'drop-trailing-slash') {
			if (hasTrailingSlash) {
				const withoutSlash = pathname.slice(0, -1);
				try {
					await fs.access(`${this.projectRoot}${withoutSlash}.html`);
					const redirectUrl = new URL(url);
					redirectUrl.pathname = withoutSlash;
					return Response.redirect(redirectUrl.toString(), 308);
				} catch {
					// No .html file
				}
			}
			return undefined;
		}

		// "auto-trailing-slash" (default)
		if (!hasTrailingSlash && pathname !== '/') {
			try {
				await fs.access(`${this.projectRoot}${pathname}/index.html`);
				const redirectUrl = new URL(url);
				redirectUrl.pathname = `${pathname}/`;
				return Response.redirect(redirectUrl.toString(), 308);
			} catch {
				// No directory/index.html
			}
		} else if (hasTrailingSlash) {
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
					redirectUrl.pathname = withoutSlash;
					return Response.redirect(redirectUrl.toString(), 308);
				} catch {
					// No .html file either
				}
			}
		}

		return undefined;
	}

	private async loadTsconfigRaw(): Promise<string | undefined> {
		try {
			const content = await fs.readFile(`${this.projectRoot}/tsconfig.json`, 'utf8');
			const tsConfig = JSON.parse(stripJsonComments(content));

			if (!tsConfig.compilerOptions) {
				try {
					const appContent = await fs.readFile(`${this.projectRoot}/tsconfig.app.json`, 'utf8');
					return toEsbuildTsconfigRaw(JSON.parse(stripJsonComments(appContent)));
				} catch {
					return undefined;
				}
			}

			return toEsbuildTsconfigRaw(tsConfig);
		} catch {
			return undefined;
		}
	}

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
