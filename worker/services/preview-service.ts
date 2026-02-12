/**
 * Preview Service.
 * Handles serving and executing user project files in the preview iframe.
 */

import fs from 'node:fs/promises';

import { transformCode } from './bundler-service';
import { transformModule, processHTML, type FileSystem } from './transform-service';

// =============================================================================
// Types
// =============================================================================

interface ServerError {
	timestamp: number;
	type: 'bundle' | 'runtime';
	message: string;
	file?: string;
	line?: number;
	column?: number;
}

// =============================================================================
// Preview Service
// =============================================================================

export class PreviewService {
	private lastBroadcastWasError = false;

	constructor(
		private projectRoot: string,
		private projectId: string,
		private environment: Env,
	) {}

	/**
	 * Serve a file from the project for preview.
	 */
	async serveFile(request: Request, baseUrl: string): Promise<Response> {
		const url = new URL(request.url);
		let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

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
				const hmrUrl = `${protocol}//${url.host}${projectPrefix}/__hmr`;
				const html = await processHTML(textContent, filePath, {
					fs: viteFs,
					projectRoot: this.projectRoot,
					baseUrl,
					hmrUrl,
				});
				return new Response(html, {
					headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
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

			// Handle JS/TS/CSS/JSON - use transformModule for import rewriting
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
			const errorMessage = String(error);
			const locMatch = errorMessage.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);
			const serverError: ServerError = {
				timestamp: Date.now(),
				type: 'bundle',
				message: errorMessage,
				file: locMatch ? locMatch[1] : undefined,
				line: locMatch ? Number(locMatch[2]) : undefined,
				column: locMatch ? Number(locMatch[3]) : undefined,
			};
			await this.broadcastMessage({ type: 'server-error', error: serverError }).catch(() => {});
			const errorJson = JSON.stringify(serverError)
				.replaceAll('<', String.raw`\u003c`)
				.replaceAll('>', String.raw`\u003e`);
			const errorModule = `if (typeof showErrorOverlay === 'function') { showErrorOverlay(${errorJson}); } else { console.error(${errorJson}.message); }`;
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
					timestamp: Date.now(),
					type: 'bundle',
					message: 'No worker/index.ts found. Create a worker/index.ts file with a default export { fetch }.',
				};
				this.lastBroadcastWasError = true;
				await this.broadcastMessage({ type: 'server-error', error: error }).catch(() => {});
				return Response.json({ error: error.message, serverError: error }, { status: 500 });
			}

			const workerFiles = Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b));
			const contentHash = await this.hashContent(JSON.stringify(workerFiles));

			const worker = this.environment.LOADER.get(`worker:${contentHash}`, async () => {
				const modules: Record<string, string> = {};
				for (const [filePath, content] of workerFiles) {
					const jsPath = filePath.replace(/\.(ts|tsx|jsx|mts)$/, '.js');
					const needsTransform = /\.(ts|tsx|jsx|mts)$/.test(filePath);
					let code = content;
					if (needsTransform) {
						const result = await transformCode(code, filePath, { sourcemap: false });
						code = result.code;
					}
					// Rewrite import specifiers to use .js extensions
					code = code.replaceAll(
						/(from\s+['"])(\.\.\/|\.\/)([^'"]+?)(\.ts|\.tsx|\.jsx|\.mts)?(['"])/g,
						(match, pre, relative, rest, extension, quote) => {
							const hasJsExtension = rest.endsWith('.js') || rest.endsWith('.mjs');
							if (extension) return `${pre}${relative}${rest}.js${quote}`;
							if (hasJsExtension) return match;
							return `${pre}${relative}${rest}.js${quote}`;
						},
					);
					modules[jsPath] = code;
				}
				return {
					compatibilityDate: '2026-01-31',
					mainModule: 'worker/index.js',
					modules,
				};
			});

			// Create request with correct path
			const apiUrl = new URL(request.url);
			apiUrl.pathname = apiPath;
			const apiRequest = new Request(apiUrl.toString(), request);

			const entrypoint = worker.getEntrypoint();
			const response = await entrypoint.fetch(apiRequest);

			if (this.lastBroadcastWasError) {
				this.lastBroadcastWasError = false;
				await this.broadcastMessage({ type: 'server-ok' }).catch(() => {});
			}

			return response;
		} catch (error) {
			const errorMessage = String(error);
			const isBundleError = errorMessage.includes('ERROR:');
			const locMatch = errorMessage.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);
			let file = locMatch ? locMatch[1] : undefined;
			let line = locMatch ? Number(locMatch[2]) : undefined;
			let column = locMatch ? Number(locMatch[3]) : undefined;

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
				timestamp: Date.now(),
				type: isBundleError ? 'bundle' : 'runtime',
				message: errorMessage,
				file,
				line,
				column,
			};

			this.lastBroadcastWasError = true;
			await this.broadcastMessage({ type: 'server-error', error: serverError }).catch(() => {});
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

	private async broadcastMessage(message: object): Promise<void> {
		const hmrId = this.environment.DO_HMR_COORDINATOR.idFromName(`hmr:${this.projectId}`);
		const hmrStub = this.environment.DO_HMR_COORDINATOR.get(hmrId);
		await hmrStub.fetch(
			new Request('http://internal/hmr/send', {
				method: 'POST',
				body: JSON.stringify(message),
			}),
		);
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
					.filter((entry: { name: string }) => entry.name !== '.ai-sessions' && entry.name !== '.snapshots')
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
