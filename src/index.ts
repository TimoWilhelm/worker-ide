import { DurableObjectFilesystem } from 'durable-object-fs';
import { mount, withMounts } from 'worker-fs-mount';
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
import fs from 'node:fs/promises';
import { transformCode, bundleCode } from './bundler.js';
import { transformModule, processHTML, type FileSystem } from './transform.js';

export { DurableObjectFilesystem };

// Module-level state for preview API (persists across requests within isolate)
const previewTodos: Array<{ id: string; text: string; done: boolean }> = [
	{ id: '1', text: 'Learn Cloudflare Workers', done: true },
	{ id: '2', text: 'Build a full-stack app', done: false },
	{ id: '3', text: 'Deploy to the edge', done: false },
];

interface HMRUpdate {
	type: 'update' | 'full-reload';
	path: string;
	timestamp: number;
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

		return new Response('Not found', { status: 404 });
	}

	async broadcast(update: HMRUpdate) {
		const message = JSON.stringify({
			type: update.type,
			updates: [
				{
					type: update.type === 'full-reload' ? 'full-reload' : 'js-update',
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

const EXAMPLE_PROJECT = {
	'package.json': `{
  "name": "my-fullstack-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}`,
	'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}`,
	'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare Workers Full-Stack App</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="src/main.ts"></script>
</body>
</html>`,
	'src/main.ts': `import { api } from './api';
import './style.css';

async function init() {
  const app = document.querySelector<HTMLDivElement>('#app')!;

  app.innerHTML = \`
    <h1>⚡ Workers Full-Stack</h1>
    <div class="card">
      <p class="status">Loading...</p>
      <div class="todos">
        <input type="text" id="todo-input" placeholder="Add a todo..." />
        <button id="add-btn">Add</button>
      </div>
      <ul id="todo-list"></ul>
    </div>
    <p class="hint">Edit <code>src/main.ts</code> for frontend, <code>src/api.ts</code> for API calls</p>
  \`;

  const status = app.querySelector<HTMLParagraphElement>('.status')!;
  const input = document.querySelector<HTMLInputElement>('#todo-input')!;
  const addBtn = document.querySelector<HTMLButtonElement>('#add-btn')!;
  const list = document.querySelector<HTMLUListElement>('#todo-list')!;

  try {
    const data = await api.hello();
    status.textContent = data.message;
  } catch (err) {
    status.textContent = 'Error connecting to API';
  }

  async function loadTodos() {
    const todos = await api.getTodos();
    list.innerHTML = todos.map(t => \`
      <li>
        <span class="\${t.done ? 'done' : ''}">\${t.text}</span>
        <button data-id="\${t.id}" class="toggle">\${t.done ? '↩' : '✓'}</button>
        <button data-id="\${t.id}" class="delete">×</button>
      </li>
    \`).join('');
  }

  await loadTodos();

  addBtn.addEventListener('click', async () => {
    if (input.value.trim()) {
      await api.addTodo(input.value.trim());
      input.value = '';
      await loadTodos();
    }
  });

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addBtn.click();
  });

  list.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const id = target.dataset.id;
    if (!id) return;
    if (target.classList.contains('toggle')) {
      await api.toggleTodo(id);
    } else if (target.classList.contains('delete')) {
      await api.deleteTodo(id);
    }
    await loadTodos();
  });
}

init();`,
	'src/api.ts': `interface Todo {
  id: string;
  text: string;
  done: boolean;
}

interface HelloResponse {
  message: string;
  timestamp: string;
}

// Detect base URL from page location (handles /preview prefix)
const getBaseUrl = () => {
  const path = location.pathname;
  if (path.startsWith('/preview')) {
    return '/preview/api';
  }
  return '/api';
};

const BASE = getBaseUrl();

export const api = {
  async hello(): Promise<HelloResponse> {
    const res = await fetch(\`\${BASE}/hello\`);
    return res.json();
  },

  async getTodos(): Promise<Todo[]> {
    const res = await fetch(\`\${BASE}/todos\`);
    return res.json();
  },

  async addTodo(text: string): Promise<Todo> {
    const res = await fetch(\`\${BASE}/todos\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.json();
  },

  async toggleTodo(id: string): Promise<Todo> {
    const res = await fetch(\`\${BASE}/todos/\${id}/toggle\`, { method: 'POST' });
    return res.json();
  },

  async deleteTodo(id: string): Promise<Todo> {
    const res = await fetch(\`\${BASE}/todos/\${id}\`, { method: 'DELETE' });
    return res.json();
  },
};`,
  'src/style.css': `:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  color: rgba(255, 255, 255, 0.87);
}

body { margin: 0; display: flex; place-items: center; min-width: 320px; min-height: 100vh; }

#app { max-width: 600px; margin: 0 auto; padding: 2rem; text-align: center; }

h1 { font-size: 2.5em; margin-bottom: 0.5em; }

.card { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 2em; margin: 1em 0; }

.status { color: #4ade80; font-weight: 500; margin-bottom: 1.5em; }

.todos { display: flex; gap: 0.5em; margin-bottom: 1em; }

.todos input {
  flex: 1; padding: 0.6em 1em; border: 1px solid rgba(255,255,255,0.2);
  border-radius: 6px; background: rgba(0,0,0,0.3); color: white; font-size: 1em;
  padding: 0.6em 1em;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 6px;
  background: rgba(0,0,0,0.3);
  color: white;
  font-size: 1em;
}

.todos input:focus {
  outline: none;
  border-color: #646cff;
}

button {
  border-radius: 6px;
  border: none;
  padding: 0.6em 1em;
  font-size: 1em;
  font-weight: 500;
  background-color: #646cff;
  color: white;
  cursor: pointer;
  transition: all 0.2s;
}

button:hover { background-color: #535bf2; }

#todo-list {
  list-style: none;
  padding: 0;
  margin: 0;
  text-align: left;
}

#todo-list li {
  display: flex;
  align-items: center;
  gap: 0.5em;
  padding: 0.75em;
  background: rgba(0,0,0,0.2);
  border-radius: 6px;
  margin-bottom: 0.5em;
}

#todo-list li span { flex: 1; }
#todo-list li span.done { text-decoration: line-through; opacity: 0.5; }

#todo-list button {
  padding: 0.3em 0.6em;
  font-size: 0.9em;
  background: rgba(255,255,255,0.1);
}

#todo-list button.delete:hover { background: #ef4444; }
#todo-list button.toggle:hover { background: #22c55e; }

.hint {
  font-size: 0.85em;
  opacity: 0.6;
}`,
};

async function ensureExampleProject(projectRoot: string) {
	try {
		await fs.access(`${projectRoot}/vite.config.ts`);
	} catch {
		for (const [filePath, content] of Object.entries(EXAMPLE_PROJECT)) {
			const fullPath = `${projectRoot}/${filePath}`;
			const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(fullPath, content);
		}
	}
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

function injectHMRClient(html: string, wsUrl: string): string {
	const hmrScript = `
<script type="module">
const socket = new WebSocket('${wsUrl}');
socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'full-reload') {
    location.reload();
  } else if (data.updates) {
    data.updates.forEach(update => {
      if (update.type === 'js-update') {
        import(update.path + '?t=' + update.timestamp);
      } else if (update.type === 'css-update') {
        const links = document.querySelectorAll('link[rel="stylesheet"]');
        links.forEach(link => {
          if (link.href.includes(update.path)) {
            link.href = update.path + '?t=' + update.timestamp;
          }
        });
      }
    });
  }
});
setInterval(() => socket.send(JSON.stringify({ type: 'ping' })), 30000);
</script>`;
	if (html.includes('</head>')) {
		return html.replace('</head>', `${hmrScript}</head>`);
	} else if (html.includes('<body>')) {
		return html.replace('<body>', `<body>${hmrScript}`);
	} else {
		return hmrScript + html;
	}
}

export default class extends WorkerEntrypoint<Env> {
	private projectRoot = '/project';

	async fetch(request: Request) {
		const url = new URL(request.url);
		const path = url.pathname;

		return withMounts(async () => {
			const fsId = this.env.DO_FILESYSTEM.idFromName('shared');
			const fsStub = this.env.DO_FILESYSTEM.get(fsId);
			mount('/project', fsStub);

			await ensureExampleProject(this.projectRoot);

			// WebSocket HMR endpoint
			if (path === '/__hmr' || path.startsWith('/__hmr')) {
				const hmrId = this.env.DO_HMR_COORDINATOR.idFromName('main');
				const hmrStub = this.env.DO_HMR_COORDINATOR.get(hmrId);
				const hmrUrl = new URL(request.url);
				hmrUrl.pathname = '/hmr';
				return hmrStub.fetch(new Request(hmrUrl, request));
			}

			// API endpoints for file modification
			if (path.startsWith('/api/')) {
				return this.handleAPI(request);
			}

			// Handle preview API routes (example project's backend)
			if (path.startsWith('/preview/api/')) {
				return this.handlePreviewAPI(request, path.replace('/preview', ''));
			}

			// Serve project files under /preview path
			if (path === '/preview' || path.startsWith('/preview/')) {
				const previewPath = path === '/preview' ? '/' : path.replace(/^\/preview/, '');
				const previewUrl = new URL(request.url);
				previewUrl.pathname = previewPath;
				return this.serveFile(new Request(previewUrl, request), { baseHref: '/preview/' });
			}

			// Fallback - should not reach here due to static assets routing
			return new Response('Not found', { status: 404 });
		});
	}

	private async handleAPI(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

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
				const hmrId = this.env.DO_HMR_COORDINATOR.idFromName('main');
				const hmrStub = this.env.DO_HMR_COORDINATOR.get(hmrId);
				const isCSS = body.path.endsWith('.css');
				await hmrStub.fetch(
					new Request('http://internal/hmr/trigger', {
						method: 'POST',
						body: JSON.stringify({
							type: isCSS ? 'update' : 'full-reload',
							path: body.path,
							timestamp: Date.now(),
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

			// POST /api/bundle - bundle project files with esbuild
			if (path === '/api/bundle' && request.method === 'POST') {
				const body = (await request.json()) as { entryPoint?: string; minify?: boolean };
				const entryPoint = body.entryPoint || 'src/main.ts';

				const files = await this.collectFilesForBundle(this.projectRoot);
				const result = await bundleCode({
					files,
					entryPoint,
					minify: body.minify ?? false,
					sourcemap: true,
				});

				return new Response(JSON.stringify({
					success: true,
					code: result.code,
					warnings: result.warnings
				}), { headers });
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

			return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
		} catch (err) {
			return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
		}
	}

	private async serveFile(request: Request, options?: { baseHref?: string }): Promise<Response> {
		const url = new URL(request.url);
		let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

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
				const hmrUrl = `${protocol}//${url.host}/__hmr`;
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

	private async handlePreviewAPI(request: Request, apiPath: string): Promise<Response> {
		const method = request.method;

		if (apiPath === '/api/hello' && method === 'GET') {
			return Response.json({
				message: 'Connected to Workers API! 🚀',
				timestamp: new Date().toISOString(),
			});
		}

		if (apiPath === '/api/todos' && method === 'GET') {
			return Response.json(previewTodos);
		}

		if (apiPath === '/api/todos' && method === 'POST') {
			const body = (await request.json()) as { text: string };
			const todo = { id: crypto.randomUUID(), text: body.text, done: false };
			previewTodos.push(todo);
			return Response.json(todo);
		}

		const toggleMatch = apiPath.match(/^\/api\/todos\/([^/]+)\/toggle$/);
		if (toggleMatch && method === 'POST') {
			const todo = previewTodos.find((t) => t.id === toggleMatch[1]);
			if (todo) {
				todo.done = !todo.done;
				return Response.json(todo);
			}
			return Response.json({ error: 'Not found' }, { status: 404 });
		}

		const deleteMatch = apiPath.match(/^\/api\/todos\/([^/]+)$/);
		if (deleteMatch && method === 'DELETE') {
			const idx = previewTodos.findIndex((t) => t.id === deleteMatch[1]);
			if (idx !== -1) {
				const [deleted] = previewTodos.splice(idx, 1);
				return Response.json(deleted);
			}
			return Response.json({ error: 'Not found' }, { status: 404 });
		}

		return Response.json({ error: 'Not found' }, { status: 404 });
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
