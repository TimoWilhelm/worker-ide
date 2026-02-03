#!/usr/bin/env npx tsx
/**
 * Programmatic Vite dev server that serves files from a Cloudflare Worker's
 * Durable Object filesystem. Uses Vite's createServer API.
 */

import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

const WORKER_URL = process.env.WORKER_URL || 'http://localhost:8787';

/**
 * Custom Vite plugin that fetches files from the Worker's DO filesystem
 */
function doFilesystemPlugin(): Plugin {
	let server: ViteDevServer;

	return {
		name: 'do-filesystem',

		configureServer(_server) {
			server = _server;

			// Add middleware to proxy file modification requests
			server.middlewares.use('/api', async (req, res, next) => {
				try {
					const url = new URL(req.url!, `http://${req.headers.host}`);
					const workerUrl = `${WORKER_URL}${url.pathname}${url.search}`;

					const response = await fetch(workerUrl, {
						method: req.method,
						headers: {
							'Content-Type': 'application/json',
						},
						body: req.method !== 'GET' ? await getRequestBody(req) : undefined,
					});

					const data = await response.text();
					res.statusCode = response.status;
					res.setHeader('Content-Type', 'application/json');
					res.end(data);
				} catch (err) {
					res.statusCode = 500;
					res.end(JSON.stringify({ error: String(err) }));
				}
			});

			// WebSocket proxy for HMR from DO
			server.middlewares.use('/__do_hmr', async (req, res, next) => {
				// This would proxy WebSocket connections to the Worker
				// For now, we use Vite's built-in HMR
				next();
			});
		},

		// Intercept resolveId to handle virtual DO files
		resolveId(id) {
			if (id.startsWith('do:')) {
				return '\0' + id;
			}
		},

		// Load files from DO filesystem
		async load(id) {
			if (id.startsWith('\0do:')) {
				const path = id.slice(4); // Remove '\0do:'
				try {
					const response = await fetch(`${WORKER_URL}/api/file?path=${encodeURIComponent(path)}`);
					if (!response.ok) return null;
					const data = await response.json() as { content: string };
					return data.content;
				} catch {
					return null;
				}
			}
		},
	};
}

function getRequestBody(req: any): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on('end', () => resolve(body));
		req.on('error', reject);
	});
}

async function main() {
	console.log('🚀 Starting Vite dev server with DO filesystem...');
	console.log(`📁 Worker URL: ${WORKER_URL}`);

	const server = await createServer({
		configFile: false,
		root: process.cwd(),
		plugins: [
			cloudflare({
				configPath: './wrangler.jsonc',
			}),
			doFilesystemPlugin(),
		],
		server: {
			port: 5173,
			hmr: {
				protocol: 'ws',
				host: 'localhost',
			},
		},
		optimizeDeps: {
			// Don't try to optimize DO files
			exclude: ['do:*'],
		},
	});

	await server.listen();
	server.printUrls();
	server.bindCLIShortcuts({ print: true });

	// Handle file changes from Worker (poll-based for now)
	// In production, you'd use WebSocket for real-time updates
	let lastFiles: string[] = [];
	const pollInterval = setInterval(async () => {
		try {
			const response = await fetch(`${WORKER_URL}/api/files`);
			const data = await response.json() as { files: string[] };

			if (JSON.stringify(data.files) !== JSON.stringify(lastFiles)) {
				console.log('📝 Files changed, triggering HMR...');
				// Trigger full reload for now
				server.ws.send({ type: 'full-reload' });
				lastFiles = data.files;
			}
		} catch {
			// Worker not running yet
		}
	}, 2000);

	// Cleanup on server close
	server.httpServer?.on('close', () => {
		clearInterval(pollInterval);
	});

	// Handle process termination
	const cleanup = () => {
		clearInterval(pollInterval);
		server.close();
	};
	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);
}

main().catch(console.error);
