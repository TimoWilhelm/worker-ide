/**
 * Worker IDE - Main Entry Point
 *
 * This is the main Cloudflare Worker entry point using Hono for routing.
 * The worker handles:
 * - API routes for file operations, sessions, snapshots
 * - Project-scoped routes (/p/:projectId/*)
 * - HMR WebSocket connections
 * - Preview serving for user projects
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { mount, withMounts } from 'worker-fs-mount';

import documentationHtml from './fixtures/docs.html?raw';
import exampleIndexHtml from './fixtures/example-project/index.html?raw';
import exampleApiTs from './fixtures/example-project/src/api.ts?raw';
import exampleMainTs from './fixtures/example-project/src/main.ts?raw';
import exampleStyleCss from './fixtures/example-project/src/style.css?raw';
import exampleTsconfig from './fixtures/example-project/tsconfig.json?raw';
import exampleWorkerDatabaseTs from './fixtures/example-project/worker/database.ts?raw';
import exampleWorkerHandlersTs from './fixtures/example-project/worker/handlers.ts?raw';
import exampleWorkerIndexTs from './fixtures/example-project/worker/index.ts?raw';
import { apiRoutes } from './routes';
import { PreviewService } from './services/preview-service';

import type { AppEnvironment } from './types';

// Re-export Durable Objects for wrangler
export { DurableObjectFilesystem, HMRCoordinator } from './durable';

const PROJECT_ROOT = '/project';

const EXAMPLE_PROJECT: Record<string, string> = {
	'tsconfig.json': exampleTsconfig,
	'index.html': exampleIndexHtml,
	'src/main.ts': exampleMainTs,
	'src/api.ts': exampleApiTs,
	'src/style.css': exampleStyleCss,
	'worker/database.ts': exampleWorkerDatabaseTs,
	'worker/handlers.ts': exampleWorkerHandlersTs,
	'worker/index.ts': exampleWorkerIndexTs,
};

// Cache for initialized projects
const initializedProjectsCache = new Set<string>();

/**
 * Initialize example project files if not already present.
 */
async function ensureExampleProject(projectRoot: string): Promise<void> {
	// Dynamic import to allow alias resolution at build time
	const fs = await import('node:fs/promises');

	const sentinelPath = `${projectRoot}/.initialized`;
	try {
		await fs.readFile(sentinelPath);
		return;
	} catch {
		// Not yet initialized
	}

	for (const [filePath, content] of Object.entries(EXAMPLE_PROJECT)) {
		const fullPath = `${projectRoot}/${filePath}`;
		try {
			await fs.readFile(fullPath);
		} catch {
			const directory = fullPath.slice(0, fullPath.lastIndexOf('/'));
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(fullPath, content);
		}
	}

	await fs.writeFile(sentinelPath, '1');
}

/**
 * Parse project route from URL path.
 */
function parseProjectRoute(path: string): { projectId: string; subPath: string } | undefined {
	const match = path.match(/^\/p\/([a-f0-9]{64})(\/.*)$/i);
	if (match) {
		return { projectId: match[1].toLowerCase(), subPath: match[2] };
	}
	const exactMatch = path.match(/^\/p\/([a-f0-9]{64})$/i);
	if (exactMatch) {
		return { projectId: exactMatch[1].toLowerCase(), subPath: '/' };
	}
	return undefined;
}

// Create the main Hono app
const app = new Hono<{ Bindings: Env }>();

// CORS middleware for API routes
app.use('/api/*', cors());
app.use('/p/*/api/*', cors());

// Documentation page
app.get('/about', (c) => {
	return c.html(documentationHtml);
});

// Create new project (needs to be outside project context)
app.post('/api/new-project', async (c) => {
	const environment = c.env;
	const id = environment.DO_FILESYSTEM.newUniqueId();
	const projectId = id.toString();
	return c.json({ projectId, url: `/p/${projectId}` });
});

// Project-scoped routes
app.all('/p/:projectId/*', async (c) => {
	const path = new URL(c.req.url).pathname;
	const projectRoute = parseProjectRoute(path);

	if (!projectRoute) {
		return c.env.ASSETS.fetch(c.req.raw);
	}

	const { projectId, subPath } = projectRoute;

	return withMounts(async () => {
		const fsId = c.env.DO_FILESYSTEM.idFromString(projectId);
		const fsStub = c.env.DO_FILESYSTEM.get(fsId);
		mount(PROJECT_ROOT, fsStub);

		// Initialize project if needed
		if (!initializedProjectsCache.has(projectId)) {
			await ensureExampleProject(PROJECT_ROOT);
			initializedProjectsCache.add(projectId);
		}

		// Refresh expiration timer
		await fsStub.refreshExpiration();

		// Handle WebSocket HMR endpoint
		if (subPath === '/__hmr' || subPath.startsWith('/__hmr')) {
			const hmrId = c.env.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
			const hmrStub = c.env.DO_HMR_COORDINATOR.get(hmrId);
			const hmrUrl = new URL(c.req.url);
			hmrUrl.pathname = '/hmr';
			return hmrStub.fetch(new Request(hmrUrl, c.req.raw));
		}

		// Handle API routes
		if (subPath.startsWith('/api/')) {
			// Create a sub-app with project context
			const projectApp = new Hono<AppEnvironment>();

			// Set project context
			projectApp.use('*', async (context, innerNext) => {
				context.set('projectId', projectId);
				context.set('projectRoot', PROJECT_ROOT);
				context.set('fsStub', fsStub);
				await innerNext();
			});

			// Mount API routes
			projectApp.route('/api', apiRoutes);

			// Rewrite the request URL to match the sub-app routes
			const apiUrl = new URL(c.req.url);
			apiUrl.pathname = subPath;

			return projectApp.fetch(new Request(apiUrl, c.req.raw), c.env, c.executionCtx);
		}

		// Handle preview API routes (user's backend code)
		if (subPath.startsWith('/preview/api/')) {
			const previewService = new PreviewService(PROJECT_ROOT, projectId, c.env);
			const apiPath = subPath.replace('/preview', '');
			return previewService.handlePreviewAPI(c.req.raw, apiPath);
		}

		// Handle preview routes (serve user's frontend files)
		if (subPath === '/preview' || subPath.startsWith('/preview/')) {
			const basePrefix = `/p/${projectId}`;
			const previewService = new PreviewService(PROJECT_ROOT, projectId, c.env);
			const previewPath = subPath === '/preview' ? '/' : subPath.replace(/^\/preview/, '');
			const previewUrl = new URL(c.req.url);
			previewUrl.pathname = previewPath;
			return previewService.serveFile(new Request(previewUrl, c.req.raw), `${basePrefix}/preview`);
		}

		// Serve the SPA for all other routes
		return c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
	});
});

// Project root without trailing content
app.get('/p/:projectId', async (c) => {
	return c.env.ASSETS.fetch(c.req.raw);
});

// Fallback to static assets
app.all('*', (c) => {
	return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
