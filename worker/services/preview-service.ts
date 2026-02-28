/**
 * Preview Service.
 * Handles serving and executing user project files in the preview iframe.
 */

import fs from 'node:fs/promises';

import { source as chobitsuSource, hash as chobitsuHash } from 'chobitsu?raw-minified';
import { env, exports } from 'cloudflare:workers';

import { HIDDEN_ENTRIES } from '@shared/constants';

import { bundleWithCdn, BundleDependencyError } from './bundler-service';
import { parseDependencyErrorsFromMessage } from './dependency-error-parser';
import { transformModule, processHTML, toEsbuildTsconfigRaw, type FileSystem } from './transform-service';
import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { source as chobitsuInitSource, hash as chobitsuInitHash } from '../lib/preview-scripts/chobitsu-init.js?raw-minified';
import { source as errorOverlaySource, hash as errorOverlayHash } from '../lib/preview-scripts/error-overlay.js?raw-minified';
import { source as fetchInterceptorSource, hash as fetchInterceptorHash } from '../lib/preview-scripts/fetch-interceptor.js?raw-minified';
import { source as hmrClientSource, hash as hmrClientHash } from '../lib/preview-scripts/hmr-client.js?raw-minified';

import type { ServerError } from '@shared/types';
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
	 * Serve a file from the project for preview.
	 */
	async serveFile(request: Request, baseUrl: string): Promise<Response> {
		const url = new URL(request.url);
		let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

		// Serve internal preview scripts (same-origin, avoids CDN issues in sandboxed iframes)
		const internalScripts: Record<string, string> = {
			'/__chobitsu.js': chobitsuSource,
			'/__chobitsu-init.js': chobitsuInitSource,
			'/__error-overlay.js': errorOverlaySource,
			'/__hmr-client.js': hmrClientSource,
			'/__fetch-interceptor.js': fetchInterceptorSource,
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

		// Check for raw query param (used by HMR for CSS)
		const isRawRequest = url.searchParams.has('raw');

		// Strip query params for file lookup
		filePath = filePath.split('?')[0];

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

			// Serve raw CSS for HMR updates
			if (isRawRequest && extension === '.css') {
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

				const bundled = await bundleWithCdn({
					files: allFiles,
					entryPoint: relativeFilePath,
					platform: 'browser',
					tsconfigRaw,
					knownDependencies,
				});

				// Broadcast dependency warnings (e.g. unused) even on successful builds.
				// Use 'dependency-warning' type so the HMR error overlay is NOT shown —
				// the overlay only triggers for type === 'bundle'.
				if (bundled.dependencyErrors && bundled.dependencyErrors.length > 0) {
					const serverError: ServerError = {
						id: crypto.randomUUID(),
						timestamp: Date.now(),
						type: 'dependency-warning',
						message: 'Dependency warnings detected',
						dependencyErrors: bundled.dependencyErrors,
					};
					await this.broadcastError(serverError).catch(() => {});
				}

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
			console.error('serveFile error:', error);
			const errorMessage = error instanceof Error ? error.message : String(error);
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
