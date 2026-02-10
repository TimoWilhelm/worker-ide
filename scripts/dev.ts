#!/usr/bin/env npx tsx
/**
 * Vite dev server that serves the project from Cloudflare Worker's DO filesystem.
 *
 * This creates a virtual filesystem where ALL files come from the Worker's
 * Durable Object storage. Vite handles transformation, HMR, and module resolution.
 *
 * Usage: WORKER_URL=http://localhost:3000 npx tsx scripts/dev.ts
 */

import { createServer, type Plugin, type ViteDevServer } from 'vite';
import path from 'path';

const WORKER_URL = process.env.WORKER_URL || 'http://localhost:3000';

// In-memory cache of files fetched from Worker
const fileCache = new Map<string, string>();
const fileList = new Set<string>();

// In-memory todos for the example project's API
const todos = [
	{ id: '1', text: 'Learn Cloudflare Workers', done: true },
	{ id: '2', text: 'Build a full-stack app', done: false },
	{ id: '3', text: 'Deploy to the edge', done: false },
];

async function fetchFileList(): Promise<string[]> {
	try {
		const response = await fetch(`${WORKER_URL}/api/files`);
		const data = (await response.json()) as { files: string[] };
		return data.files || [];
	} catch {
		return [];
	}
}

async function fetchFile(filePath: string): Promise<string | null> {
	try {
		const response = await fetch(`${WORKER_URL}/api/file?path=${encodeURIComponent(filePath)}`);
		if (!response.ok) return null;
		const data = (await response.json()) as { content: string };
		return data.content;
	} catch {
		return null;
	}
}

async function refreshFileList(): Promise<void> {
	const files = await fetchFileList();
	fileList.clear();
	files.forEach((f) => fileList.add(f));
}

function getRequestBody(req: any): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', (chunk: Buffer) => (body += chunk.toString()));
		req.on('end', () => resolve(body));
		req.on('error', reject);
	});
}

/**
 * Vite plugin that serves files from the Worker's DO filesystem
 */
function doFilesystemPlugin(): Plugin {
	return {
		name: 'do-filesystem',

		configureServer(server: ViteDevServer) {
			// Handle the example project's API routes
			server.middlewares.use('/api', async (req, res, next) => {
				const url = new URL(req.url!, `http://${req.headers.host}`);
				const apiPath = url.pathname;
				const method = req.method || 'GET';

				res.setHeader('Content-Type', 'application/json');
				res.setHeader('Access-Control-Allow-Origin', '*');

				if (method === 'OPTIONS') {
					res.statusCode = 200;
					res.end();
					return;
				}

				// GET /api/hello
				if (apiPath === '/hello' && method === 'GET') {
					res.end(JSON.stringify({ message: 'Connected to Workers API! 🚀', timestamp: new Date().toISOString() }));
					return;
				}

				// GET /api/todos
				if (apiPath === '/todos' && method === 'GET') {
					res.end(JSON.stringify(todos));
					return;
				}

				// POST /api/todos
				if (apiPath === '/todos' && method === 'POST') {
					const body = JSON.parse(await getRequestBody(req)) as { text: string };
					const todo = { id: crypto.randomUUID(), text: body.text, done: false };
					todos.push(todo);
					res.end(JSON.stringify(todo));
					return;
				}

				// POST /api/todos/:id/toggle
				const toggleMatch = apiPath.match(/^\/todos\/([^/]+)\/toggle$/);
				if (toggleMatch && method === 'POST') {
					const todo = todos.find((t) => t.id === toggleMatch[1]);
					if (todo) {
						todo.done = !todo.done;
						res.end(JSON.stringify(todo));
						return;
					}
					res.statusCode = 404;
					res.end(JSON.stringify({ error: 'Not found' }));
					return;
				}

				// DELETE /api/todos/:id
				const deleteMatch = apiPath.match(/^\/todos\/([^/]+)$/);
				if (deleteMatch && method === 'DELETE') {
					const idx = todos.findIndex((t) => t.id === deleteMatch[1]);
					if (idx !== -1) {
						const [deleted] = todos.splice(idx, 1);
						res.end(JSON.stringify(deleted));
						return;
					}
					res.statusCode = 404;
					res.end(JSON.stringify({ error: 'Not found' }));
					return;
				}

				res.statusCode = 404;
				res.end(JSON.stringify({ error: 'Not found' }));
			});
		},

		// Resolve module IDs - handle all files as coming from DO
		async resolveId(id, importer) {
			// Entry point or absolute paths
			if (!importer) {
				if (id.startsWith('/')) {
					return { id: `\0do:${id}`, moduleSideEffects: true };
				}
				return null;
			}

			// Relative imports
			if (id.startsWith('.')) {
				const importerPath = importer.startsWith('\0do:') ? importer.slice(4) : importer;
				const dir = path.dirname(importerPath);
				let resolved = path.posix.join(dir, id);
				if (!resolved.startsWith('/')) resolved = '/' + resolved;

				// Try with extensions if not provided
				const ext = path.extname(resolved);
				if (!ext) {
					const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
					for (const tryExt of extensions) {
						if (fileList.has(resolved + tryExt)) {
							return { id: `\0do:${resolved}${tryExt}`, moduleSideEffects: true };
						}
					}
					// Try index files
					for (const tryExt of extensions) {
						if (fileList.has(`${resolved}/index${tryExt}`)) {
							return { id: `\0do:${resolved}/index${tryExt}`, moduleSideEffects: true };
						}
					}
				}

				if (fileList.has(resolved)) {
					return { id: `\0do:${resolved}`, moduleSideEffects: true };
				}
			}

			return null;
		},

		// Load file content from DO
		async load(id) {
			if (!id.startsWith('\0do:')) return null;

			const filePath = id.slice(4);
			let content = fileCache.get(filePath);

			if (content === undefined) {
				content = (await fetchFile(filePath)) ?? undefined;
				if (content !== undefined) {
					fileCache.set(filePath, content);
				}
			}

			if (content === undefined) {
				console.error(`[do-filesystem] File not found: ${filePath}`);
				return null;
			}

			return content;
		},

		// Handle HTML transforms
		transformIndexHtml: {
			order: 'pre',
			async handler(html, ctx) {
				// Rewrite script src to use virtual module prefix
				return html.replace(/<script([^>]*)\ssrc=["']([^"']+)["']/gi, (match, attrs, src) => {
					if (src.startsWith('http') || src.startsWith('//')) return match;
					const resolvedSrc = src.startsWith('/') ? src : `/${src}`;
					return `<script${attrs} src="${resolvedSrc}"`;
				});
			},
		},
	};
}

async function main() {
	console.log('🚀 Starting Vite dev server with DO filesystem...');
	console.log(`📁 Worker URL: ${WORKER_URL}`);

	// Initial file list fetch
	await refreshFileList();
	console.log(`📄 Found ${fileList.size} files in DO filesystem`);

	const server = await createServer({
		configFile: false,
		root: process.cwd(),
		plugins: [doFilesystemPlugin()],
		server: {
			port: 3000,
			cors: true,
			hmr: {
				protocol: 'ws',
				host: 'localhost',
			},
		},
		optimizeDeps: {
			// Disable dep optimization - we serve everything from DO
			noDiscovery: true,
			include: [],
		},
		appType: 'custom',
	});

	// Serve index.html from DO for root requests
	server.middlewares.use(async (req, res, next) => {
		if (req.url === '/' || req.url === '/index.html') {
			let html = await fetchFile('/index.html');
			if (html) {
				html = await server.transformIndexHtml(req.url, html);
				res.setHeader('Content-Type', 'text/html');
				res.end(html);
				return;
			}
		}
		next();
	});

	await server.listen();
	server.printUrls();
	server.bindCLIShortcuts({ print: true });

	// Poll for file changes
	let lastFileHash = '';
	const pollInterval = setInterval(async () => {
		try {
			await refreshFileList();
			const currentHash = Array.from(fileList).sort().join(',');

			if (currentHash !== lastFileHash && lastFileHash !== '') {
				console.log('📝 Files changed, clearing cache and triggering reload...');
				fileCache.clear();
				server.ws.send({ type: 'full-reload' });
			}
			lastFileHash = currentHash;
		} catch {
			// Worker not running
		}
	}, 1000);

	const cleanup = () => {
		clearInterval(pollInterval);
		server.close();
	};
	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);
}

main().catch(console.error);
