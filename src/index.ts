import { DurableObjectFilesystem } from 'durable-object-fs';
import { mount, withMounts } from 'worker-fs-mount';
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
import fs from 'node:fs/promises';
import { transformCode } from './bundler.js';
import { transformModule, processHTML, type FileSystem } from './transform.js';
import examplePackageJson from './example-project/package.json?raw';
import exampleTsconfig from './example-project/tsconfig.json?raw';
import exampleIndexHtml from './example-project/index.html?raw';
import exampleMainTs from './example-project/src/main.ts?raw';
import exampleApiTs from './example-project/src/api.ts?raw';
import exampleStyleCss from './example-project/src/style.css?raw';
import exampleWorkerDbTs from './example-project/worker/db.ts?raw';
import exampleWorkerHandlersTs from './example-project/worker/handlers.ts?raw';
import exampleWorkerIndexTs from './example-project/worker/index.ts?raw';

export { DurableObjectFilesystem };

// Server error type for the UI terminal
interface ServerError {
	timestamp: number;
	type: 'bundle' | 'runtime';
	message: string;
	file?: string;
	line?: number;
	column?: number;
}

interface HMRUpdate {
	type: 'update' | 'full-reload';
	path: string;
	timestamp: number;
	isCSS?: boolean;
}

export class HMRCoordinator extends DurableObject {
	private sessions: Map<WebSocket, { id: string }> = new Map();

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/hmr' && request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			this.ctx.acceptWebSocket(server);
			this.sessions.set(server, { id: crypto.randomUUID() });

			return new Response(null, { status: 101, webSocket: client });
		}

		if (url.pathname === '/hmr/trigger' && request.method === 'POST') {
			const update = (await request.json()) as HMRUpdate;
			await this.broadcast(update);
			return new Response(JSON.stringify({ success: true }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.pathname === '/hmr/send' && request.method === 'POST') {
			const message = await request.text();
			this.broadcastRaw(message);
			return new Response(JSON.stringify({ success: true }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		return new Response('Not found', { status: 404 });
	}

	async broadcast(update: HMRUpdate) {
		let updateType: string;
		if (update.type === 'full-reload') {
			updateType = 'full-reload';
		} else if (update.isCSS) {
			updateType = 'css-update';
		} else {
			updateType = 'js-update';
		}

		const message = JSON.stringify({
			type: update.type,
			updates: [
				{
					type: updateType,
					path: update.path,
					timestamp: update.timestamp,
				},
			],
		});

		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(message);
			} catch {
				this.sessions.delete(ws);
			}
		}
	}

	broadcastRaw(message: string) {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(message);
			} catch {
				this.sessions.delete(ws);
			}
		}
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			const messageStr = typeof message === 'string' ? message : new TextDecoder().decode(message);
			const data = JSON.parse(messageStr);
			if (data.type === 'ping') {
				ws.send(JSON.stringify({ type: 'pong' }));
			}
		} catch {}
	}

	webSocketClose(ws: WebSocket) {
		this.sessions.delete(ws);
	}
}

const EXAMPLE_PROJECT: Record<string, string> = {
	'package.json': examplePackageJson,
	'tsconfig.json': exampleTsconfig,
	'index.html': exampleIndexHtml,
	'src/main.ts': exampleMainTs,
	'src/api.ts': exampleApiTs,
	'src/style.css': exampleStyleCss,
	'worker/db.ts': exampleWorkerDbTs,
	'worker/handlers.ts': exampleWorkerHandlersTs,
	'worker/index.ts': exampleWorkerIndexTs,
};

async function ensureExampleProject(projectRoot: string) {
	const sentinelPath = `${projectRoot}/.initialized`;
	try {
		await fs.readFile(sentinelPath);
		return;
	} catch {
		// not yet initialized
	}
	for (const [filePath, content] of Object.entries(EXAMPLE_PROJECT)) {
		const fullPath = `${projectRoot}/${filePath}`;
		try {
			await fs.readFile(fullPath);
		} catch {
			const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(fullPath, content);
		}
	}
	await fs.writeFile(sentinelPath, '1');
}

function isPathSafe(basePath: string, requestedPath: string): boolean {
	const normalizedPath = requestedPath.replace(/\/+/g, '/').replace(/\.\.\/|\.\.$/g, '');
	if (requestedPath !== normalizedPath || requestedPath.includes('..')) {
		return false;
	}
	return true;
}

function getContentType(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase();
	const types: Record<string, string> = {
		html: 'text/html',
		js: 'application/javascript',
		mjs: 'application/javascript',
		css: 'text/css',
		json: 'application/json',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		webp: 'image/webp',
		svg: 'image/svg+xml',
		ico: 'image/x-icon',
		woff: 'font/woff',
		woff2: 'font/woff2',
		ttf: 'font/ttf',
		eot: 'application/vnd.ms-fontobject',
		mp3: 'audio/mpeg',
		wav: 'audio/wav',
		mp4: 'video/mp4',
		webm: 'video/webm',
		txt: 'text/plain',
		md: 'text/markdown',
	};
	return types[ext || ''] || 'application/octet-stream';
}

interface TransformResult {
	body: string | Uint8Array;
	contentType: string;
}

const TRANSFORM_TO_JS_MODULE = new Set(['.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.txt', '.md']);
const COMPILE_TO_JS = new Set(['.ts', '.tsx', '.jsx', '.mts']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.wav', '.mp4', '.webm']);

function getExtension(path: string): string {
	const match = path.match(/\.[^.]+$/);
	return match ? match[0].toLowerCase() : '';
}

function transformToJsModule(content: string | Uint8Array, filePath: string, contentType: string): TransformResult {
	const ext = getExtension(filePath);

	if (ext === '.css') {
		const cssContent = JSON.stringify(typeof content === 'string' ? content : new TextDecoder().decode(content));
		return {
			body: `const css = ${cssContent};
const style = document.createElement('style');
style.setAttribute('data-dev-id', ${JSON.stringify(filePath)});
style.textContent = css;
document.head.appendChild(style);
export default css;`,
			contentType: 'application/javascript',
		};
	}

	if (ext === '.json') {
		const jsonContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
		return {
			body: `export default ${jsonContent};`,
			contentType: 'application/javascript',
		};
	}

	if (ext === '.svg') {
		const svgContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
		const dataUrl = `data:image/svg+xml,${encodeURIComponent(svgContent)}`;
		return {
			body: `export default ${JSON.stringify(dataUrl)};`,
			contentType: 'application/javascript',
		};
	}

	if (BINARY_EXTENSIONS.has(ext)) {
		const binary = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
		let base64 = '';
		const chunkSize = 8192;
		for (let i = 0; i < binary.length; i += chunkSize) {
			const chunk = binary.subarray(i, i + chunkSize);
			base64 += String.fromCharCode(...chunk);
		}
		base64 = btoa(base64);
		const dataUrl = `data:${contentType};base64,${base64}`;
		return {
			body: `export default ${JSON.stringify(dataUrl)};`,
			contentType: 'application/javascript',
		};
	}

	if (ext === '.txt' || ext === '.md') {
		const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
		return {
			body: `export default ${JSON.stringify(textContent)};`,
			contentType: 'application/javascript',
		};
	}

	return { body: content, contentType };
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
		table[i] = c;
	}
	return table;
})();

function crc32(data: Uint8Array): number {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createZip(files: Record<string, string | Uint8Array>): Uint8Array {
	const encoder = new TextEncoder();
	const entries: { name: Uint8Array; data: Uint8Array; crc: number; offset: number }[] = [];
	const parts: Uint8Array[] = [];
	let offset = 0;

	for (const [name, content] of Object.entries(files)) {
		const nameBytes = encoder.encode(name);
		const dataBytes = typeof content === 'string' ? encoder.encode(content) : content;
		const fileCrc = crc32(dataBytes);

		const header = new Uint8Array(30 + nameBytes.length);
		const hv = new DataView(header.buffer);
		hv.setUint32(0, 0x04034b50, true);
		hv.setUint16(4, 20, true);
		hv.setUint32(14, fileCrc, true);
		hv.setUint32(18, dataBytes.length, true);
		hv.setUint32(22, dataBytes.length, true);
		hv.setUint16(26, nameBytes.length, true);
		header.set(nameBytes, 30);

		entries.push({ name: nameBytes, data: dataBytes, crc: fileCrc, offset });
		parts.push(header, dataBytes);
		offset += header.length + dataBytes.length;
	}

	const cdStart = offset;
	for (const entry of entries) {
		const cd = new Uint8Array(46 + entry.name.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint32(16, entry.crc, true);
		cv.setUint32(20, entry.data.length, true);
		cv.setUint32(24, entry.data.length, true);
		cv.setUint16(28, entry.name.length, true);
		cv.setUint32(42, entry.offset, true);
		cd.set(entry.name, 46);
		parts.push(cd);
		offset += cd.length;
	}

	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, offset - cdStart, true);
	ev.setUint32(16, cdStart, true);
	parts.push(eocd);

	const total = parts.reduce((s, p) => s + p.length, 0);
	const result = new Uint8Array(total);
	let pos = 0;
	for (const part of parts) { result.set(part, pos); pos += part.length; }
	return result;
}

function parseProjectRoute(path: string): { projectId: string; subPath: string } | null {
	const match = path.match(/^\/p\/([a-f0-9]{64})(\/.*)$/i);
	if (match) {
		return { projectId: match[1].toLowerCase(), subPath: match[2] };
	}
	const exactMatch = path.match(/^\/p\/([a-f0-9]{64})$/i);
	if (exactMatch) {
		return { projectId: exactMatch[1].toLowerCase(), subPath: '/' };
	}
	return null;
}

export default class extends WorkerEntrypoint<Env> {
	private projectRoot = '/project';
	private lastBroadcastWasErrorMap = new Map<string, boolean>();
	private initializedProjectsCache = new Set<string>();

	private setLastBroadcastWasError(projectId: string, value: boolean) {
		this.lastBroadcastWasErrorMap.set(projectId, value);
	}

	private async broadcastMessage(projectId: string, message: object) {
		const hmrId = this.env.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
		const hmrStub = this.env.DO_HMR_COORDINATOR.get(hmrId);
		await hmrStub.fetch(new Request('http://internal/hmr/send', {
			method: 'POST',
			body: JSON.stringify(message),
		}));
	}

	async fetch(request: Request) {
		const url = new URL(request.url);
		const path = url.pathname;

		// API to create a new project
		if (path === '/api/new-project' && request.method === 'POST') {
			const id = this.env.DO_FILESYSTEM.newUniqueId();
			const projectId = id.toString();
			return Response.json({ projectId, url: `/p/${projectId}` });
		}

		// Handle project-scoped routes: /p/:projectId/*
		const projectRoute = parseProjectRoute(path);
		if (projectRoute) {
			return this.handleProjectRequest(request, projectRoute.projectId, projectRoute.subPath);
		}

		// All other routes serve the IDE HTML (SPA handles redirect to /p/:projectId)
		return this.env.ASSETS.fetch(request);
	}

	private async handleProjectRequest(request: Request, projectId: string, subPath: string): Promise<Response> {
		return withMounts(async () => {
			const fsId = this.env.DO_FILESYSTEM.idFromString(projectId);
			const fsStub = this.env.DO_FILESYSTEM.get(fsId);
			mount('/project', fsStub);

			if (!this.initializedProjectsCache.has(projectId)) {
				await ensureExampleProject(this.projectRoot);
				this.initializedProjectsCache.add(projectId);
			}

			const basePrefix = `/p/${projectId}`;

			// WebSocket HMR endpoint
			if (subPath === '/__hmr' || subPath.startsWith('/__hmr')) {
				const hmrId = this.env.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
				const hmrStub = this.env.DO_HMR_COORDINATOR.get(hmrId);
				const hmrUrl = new URL(request.url);
				hmrUrl.pathname = '/hmr';
				return hmrStub.fetch(new Request(hmrUrl, request));
			}

			// API endpoints for file modification
			if (subPath.startsWith('/api/')) {
				return this.handleAPI(request, projectId, basePrefix);
			}

			// Handle preview API routes (example project's backend)
			if (subPath.startsWith('/preview/api/')) {
				return this.handlePreviewAPI(request, subPath.replace('/preview', ''), projectId);
			}

			// Serve project files under /preview path
			if (subPath === '/preview' || subPath.startsWith('/preview/')) {
				const previewPath = subPath === '/preview' ? '/' : subPath.replace(/^\/preview/, '');
				const previewUrl = new URL(request.url);
				previewUrl.pathname = previewPath;
				return this.serveFile(new Request(previewUrl, request), { baseHref: `${basePrefix}/preview/` });
			}

			// Serve the IDE HTML for the project root and any unknown sub-paths
			return this.env.ASSETS.fetch(new Request(new URL('/', request.url), request));
		});
	}

	private async handleAPI(request: Request, projectId: string, basePrefix?: string): Promise<Response> {
		const url = new URL(request.url);
		// Strip basePrefix from path for matching
		const fullPath = url.pathname;
		const path = basePrefix && fullPath.startsWith(basePrefix) ? fullPath.slice(basePrefix.length) : fullPath;

		const headers = {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers });
		}

		try {
			// GET /api/files - list all files
			if (path === '/api/files' && request.method === 'GET') {
				const files = await this.listFilesRecursive(this.projectRoot);
				return new Response(JSON.stringify({ files }), { headers });
			}

			// GET /api/file?path=/src/main.js - read file
			if (path === '/api/file' && request.method === 'GET') {
				const filePath = url.searchParams.get('path');
				if (!filePath) {
					return new Response(JSON.stringify({ error: 'path required' }), {
						status: 400,
						headers,
					});
				}
				if (!isPathSafe(this.projectRoot, filePath)) {
					return new Response(JSON.stringify({ error: 'invalid path' }), {
						status: 400,
						headers,
					});
				}
				const content = await fs.readFile(`${this.projectRoot}${filePath}`, 'utf8');
				return new Response(JSON.stringify({ path: filePath, content }), { headers });
			}

			// PUT /api/file - write file and trigger HMR
			if (path === '/api/file' && request.method === 'PUT') {
				const body = (await request.json()) as { path: string; content: string };
				if (!isPathSafe(this.projectRoot, body.path)) {
					return new Response(JSON.stringify({ error: 'invalid path' }), {
						status: 400,
						headers,
					});
				}
				await fs.writeFile(`${this.projectRoot}${body.path}`, body.content);

				// Trigger HMR update
				const hmrId = this.env.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
				const hmrStub = this.env.DO_HMR_COORDINATOR.get(hmrId);
				const isCSS = body.path.endsWith('.css');
				await hmrStub.fetch(
					new Request('http://internal/hmr/trigger', {
						method: 'POST',
						body: JSON.stringify({
							type: isCSS ? 'update' : 'full-reload',
							path: body.path,
							timestamp: Date.now(),
							isCSS,
						}),
					})
				);

				return new Response(JSON.stringify({ success: true, path: body.path }), { headers });
			}

			// DELETE /api/file?path=/src/old.js - delete file
			if (path === '/api/file' && request.method === 'DELETE') {
				const filePath = url.searchParams.get('path');
				if (!filePath) {
					return new Response(JSON.stringify({ error: 'path required' }), {
						status: 400,
						headers,
					});
				}
				if (!isPathSafe(this.projectRoot, filePath)) {
					return new Response(JSON.stringify({ error: 'invalid path' }), {
						status: 400,
						headers,
					});
				}
				await fs.unlink(`${this.projectRoot}${filePath}`);
				return new Response(JSON.stringify({ success: true }), { headers });
			}

			// POST /api/mkdir - create directory
			if (path === '/api/mkdir' && request.method === 'POST') {
				const body = (await request.json()) as { path: string };
				if (!isPathSafe(this.projectRoot, body.path)) {
					return new Response(JSON.stringify({ error: 'invalid path' }), {
						status: 400,
						headers,
					});
				}
				await fs.mkdir(`${this.projectRoot}${body.path}`, { recursive: true });
				return new Response(JSON.stringify({ success: true }), { headers });
			}

			// POST /api/transform - transform a single file with esbuild
			if (path === '/api/transform' && request.method === 'POST') {
				const body = (await request.json()) as { code: string; filename: string };
				const result = await transformCode(body.code, body.filename, { sourcemap: true });
				return new Response(JSON.stringify({
					success: true,
					code: result.code,
					map: result.map
				}), { headers });
			}

			// GET /api/download - download project as deployable zip
			if (path === '/api/download' && request.method === 'GET') {
				const projectFiles = await this.collectFilesForBundle(this.projectRoot);
				delete projectFiles['.initialized'];

				let pkgJson: Record<string, unknown> = {};
				let projectName = 'my-worker-app';
				if (projectFiles['package.json']) {
					try {
						pkgJson = JSON.parse(projectFiles['package.json']);
						if (typeof pkgJson.name === 'string') projectName = pkgJson.name;
					} catch {}
				}

				pkgJson.scripts = {
					...(pkgJson.scripts as Record<string, string> || {}),
					dev: 'vite dev',
					build: 'vite build',
					deploy: 'vite build && wrangler deploy',
				};
				pkgJson.devDependencies = {
					...(pkgJson.devDependencies as Record<string, string> || {}),
					'@cloudflare/vite-plugin': '^1.0.0',
					vite: '^6.0.0',
					wrangler: '^4.0.0',
				};

				const prefix = `${projectName}/`;
				const zipFiles: Record<string, string> = {};

				for (const [filePath, content] of Object.entries(projectFiles)) {
					if (filePath === 'package.json') continue;
					zipFiles[`${prefix}${filePath}`] = content;
				}

				zipFiles[`${prefix}package.json`] = JSON.stringify(pkgJson, null, 2);

				zipFiles[`${prefix}wrangler.jsonc`] = JSON.stringify({
					$schema: 'node_modules/wrangler/config-schema.json',
					name: projectName,
					main: 'worker/index.ts',
					compatibility_date: '2026-01-31',
					assets: {
						not_found_handling: 'single-page-application',
						run_worker_first: ['/api/*'],
					},
					observability: {
						enabled: true,
					},
				}, null, '\t');

				zipFiles[`${prefix}vite.config.ts`] = [
					'import { defineConfig } from \'vite\';',
					'import { cloudflare } from \'@cloudflare/vite-plugin\';',
					'',
					'export default defineConfig({',
					'\tplugins: [cloudflare()],',
					'});',
					'',
				].join('\n');

				const zip = createZip(zipFiles);
				return new Response(zip, {
					headers: {
						'Content-Type': 'application/zip',
						'Content-Disposition': `attachment; filename="${projectName}.zip"`,
						'Access-Control-Allow-Origin': '*',
					},
				});
			}

			return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
		} catch (err) {
			return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
		}
	}

	private async serveFile(request: Request, options?: { baseHref?: string }): Promise<Response> {
		const url = new URL(request.url);
		let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

		// Check for raw query param (used by HMR for CSS)
		const isRawRequest = url.searchParams.has('raw');

		// Strip query params for file lookup
		filePath = filePath.split('?')[0];

		const baseUrl = options?.baseHref?.replace(/\/$/, '') || '';

		// Create filesystem adapter for vite-dev
		const viteFs: FileSystem = {
			readFile: (path: string) => fs.readFile(path),
			access: (path: string) => fs.access(path),
		};

		try {
			// Resolve extensionless imports
			let fullPath = `${this.projectRoot}${filePath}`;
			const initialExt = getExtension(filePath);

			if (!initialExt) {
				const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
				let resolved = false;
				for (const tryExt of extensions) {
					try {
						await fs.access(fullPath + tryExt);
						fullPath = fullPath + tryExt;
						filePath = filePath + tryExt;
						resolved = true;
						break;
					} catch {
						// Try next
					}
				}
				if (!resolved) {
					for (const tryExt of extensions) {
						try {
							await fs.access(fullPath + '/index' + tryExt);
							fullPath = fullPath + '/index' + tryExt;
							filePath = filePath + '/index' + tryExt;
							resolved = true;
							break;
						} catch {
							// Try next
						}
					}
				}
				if (!resolved) {
					throw new Error(`ENOENT: no such file or directory, '${filePath}'`);
				}
			}

			const content = await fs.readFile(fullPath);
			const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content as unknown as Uint8Array);
			const ext = getExtension(filePath);

			// Handle HTML files - use processHTML for proper script/link rewriting
			if (ext === '.html') {
				const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
				// Extract project prefix from baseUrl (e.g., /p/abc123/preview -> /p/abc123)
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

			// Serve raw CSS for HMR updates (no transformation to JS module)
			if (isRawRequest && ext === '.css') {
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
		} catch (err) {
			console.error('serveFile error:', err);
			return new Response('Not found', { status: 404 });
		}
	}

	private async handlePreviewAPI(request: Request, apiPath: string, projectId: string): Promise<Response> {
		try {
			const files = await this.collectFilesForBundle(this.projectRoot);

			// Check if worker/index.ts exists
			const workerEntry = Object.keys(files).find(f =>
				f === 'worker/index.ts' || f === 'worker/index.js'
			);

			if (!workerEntry) {
				const err: ServerError = { timestamp: Date.now(), type: 'bundle', message: 'No worker/index.ts found. Create a worker/index.ts file with a default export { fetch }.' };
				this.setLastBroadcastWasError(projectId, true);
				this.broadcastMessage(projectId, { type: 'server-error', error: err }).catch(() => {});
				return Response.json({ error: err.message, serverError: err }, { status: 500 });
			}

			// Collect only worker/ files for hashing (cheap)
			const workerFiles = Object.entries(files)
				.filter(([path]) => path.startsWith('worker/'))
				.sort(([a], [b]) => a.localeCompare(b));
			const contentHash = await this.hashContent(JSON.stringify(workerFiles));

			// Transform is deferred into getCode — only runs if no warm isolate exists for this hash
			const worker = this.env.LOADER.get(`worker:${contentHash}`, async () => {
				const modules: Record<string, string> = {};
				for (const [filePath, content] of workerFiles) {
					// Convert .ts/.tsx/.jsx to .js for the module name
					const jsPath = filePath.replace(/\.(ts|tsx|jsx|mts)$/, '.js');
					const needsTransform = /\.(ts|tsx|jsx|mts)$/.test(filePath);
					let code = content;
					if (needsTransform) {
						const result = await transformCode(code, filePath, { sourcemap: false });
						code = result.code;
					}
					// Rewrite import specifiers to use .js extensions
					code = code.replace(
						/(from\s+['"])(\.\.\/|\.\/)([^'"]+?)(\.ts|\.tsx|\.jsx|\.mts)?(['"])/g,
						(match, pre, rel, rest, ext, quote) => {
							const hasJsExt = rest.endsWith('.js') || rest.endsWith('.mjs');
							if (ext) return `${pre}${rel}${rest}.js${quote}`;
							if (hasJsExt) return match;
							return `${pre}${rel}${rest}.js${quote}`;
						}
					);
					modules[jsPath] = code;
				}
				return {
					compatibilityDate: '2026-01-31',
					mainModule: 'worker/index.js',
					modules,
				};
			});

			// Create a new request with the correct path (strip /preview prefix)
			const apiUrl = new URL(request.url);
			apiUrl.pathname = apiPath;
			const apiRequest = new Request(apiUrl.toString(), request);

			const entrypoint = worker.getEntrypoint();
			const response = await entrypoint.fetch(apiRequest);
			if (this.lastBroadcastWasErrorMap.get(projectId)) {
				this.setLastBroadcastWasError(projectId, false);
				this.broadcastMessage(projectId, { type: 'server-ok' }).catch(() => {});
			}
			return response;
		} catch (err) {
			const errMsg = String(err);
			const isBundleError = errMsg.includes('ERROR:');
			const locMatch = errMsg.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);
			const serverErr: ServerError = {
				timestamp: Date.now(),
				type: isBundleError ? 'bundle' : 'runtime',
				message: errMsg,
				file: locMatch ? locMatch[1] : undefined,
				line: locMatch ? Number(locMatch[2]) : undefined,
				column: locMatch ? Number(locMatch[3]) : undefined,
			};
			this.setLastBroadcastWasError(projectId, true);
			this.broadcastMessage(projectId, { type: 'server-error', error: serverErr }).catch(() => {});
			console.error('Server code execution error:', err);
			return Response.json({ error: errMsg, serverError: serverErr }, { status: 500 });
		}
	}

	private async hashContent(content: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(content);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	private async listFilesRecursive(dir: string, base = ''): Promise<string[]> {
		const files: string[] = [];
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const relativePath = base ? `${base}/${entry.name}` : `/${entry.name}`;
				if (entry.isDirectory()) {
					files.push(...(await this.listFilesRecursive(`${dir}/${entry.name}`, relativePath)));
				} else {
					files.push(relativePath);
				}
			}
		} catch (err) {
			if (base === '') {
				console.error('listFilesRecursive error:', err);
			}
		}
		return files;
	}

	private async collectFilesForBundle(dir: string, base = ''): Promise<Record<string, string>> {
		const files: Record<string, string> = {};
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const relativePath = base ? `${base}/${entry.name}` : entry.name;
				const fullPath = `${dir}/${entry.name}`;
				if (entry.isDirectory()) {
					Object.assign(files, await this.collectFilesForBundle(fullPath, relativePath));
				} else {
					const content = await fs.readFile(fullPath, 'utf8');
					files[relativePath] = content;
				}
			}
		} catch (err) {
			if (base === '') {
				console.error('collectFilesForBundle error:', err);
			}
		}
		return files;
	}
}
