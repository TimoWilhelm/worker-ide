/**
 * Worker IDE - Main Entry Point
 *
 * This is the main Cloudflare Worker entry point using Hono for routing.
 * The worker handles:
 * - API routes for file operations, sessions, snapshots
 * - Project-scoped routes (/p/:projectId/*)
 * - Project WebSocket connections (HMR, collaboration, server events)
 * - Preview serving for user projects
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { mount, withMounts } from 'worker-fs-mount';

import { generateHumanId } from '@shared/human-id';

import exampleIndexHtml from './fixtures/example-project/index.html?raw';
import exampleAppTsx from './fixtures/example-project/src/app.tsx?raw';
import exampleMainTsx from './fixtures/example-project/src/main.tsx?raw';
import exampleStyleCss from './fixtures/example-project/src/style.css?raw';
import exampleTsconfig from './fixtures/example-project/tsconfig.json?raw';
import exampleWorkerDatabaseTs from './fixtures/example-project/worker/database.ts?raw';
import exampleWorkerIndexTs from './fixtures/example-project/worker/index.ts?raw';
import { apiRoutes } from './routes';
import { PreviewService } from './services/preview-service';

import type { AppEnvironment } from './types';

/**
 * Cache PreviewService instances per projectId so that error deduplication
 * (lastErrorMessage) works across requests within the same isolate.
 */
const MAX_PREVIEW_SERVICE_CACHE_SIZE = 100;
const previewServiceCache = new Map<string, PreviewService>();
function getPreviewService(projectRoot: string, projectId: string): PreviewService {
	let service = previewServiceCache.get(projectId);
	if (service) {
		// Move to end (most recently used)
		previewServiceCache.delete(projectId);
		previewServiceCache.set(projectId, service);
		return service;
	}
	// Evict oldest entry if cache is full
	if (previewServiceCache.size >= MAX_PREVIEW_SERVICE_CACHE_SIZE) {
		const oldestKey = previewServiceCache.keys().next().value;
		if (oldestKey !== undefined) {
			previewServiceCache.delete(oldestKey);
		}
	}
	service = new PreviewService(projectRoot, projectId);
	previewServiceCache.set(projectId, service);
	return service;
}

// Re-export Durable Objects for wrangler
export { DurableObjectFilesystem, ProjectCoordinator } from './durable';

// Re-export LogTailer so it's available on ctx.exports for WorkerLoader tails
export { LogTailer } from './services/log-tailer';

const PROJECT_ROOT = '/project';

const EXAMPLE_PROJECT: Record<string, string> = {
	'tsconfig.json': exampleTsconfig,
	'index.html': exampleIndexHtml,
	'src/main.tsx': exampleMainTsx,
	'src/app.tsx': exampleAppTsx,
	'src/style.css': exampleStyleCss,
	'worker/database.ts': exampleWorkerDatabaseTs,
	'worker/index.ts': exampleWorkerIndexTs,
};

/**
 * Initialize example project files if not already present.
 * Uses a sentinel file on disk as the source of truth so that
 * re-initialization happens correctly after a DO storage wipe.
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

	// Write initial project metadata with default dependencies
	const metaPath = `${projectRoot}/.project-meta.json`;
	try {
		await fs.readFile(metaPath);
	} catch {
		const { generateHumanId } = await import('@shared/human-id');
		const humanId = generateHumanId();
		const meta = {
			name: humanId,
			humanId,
			dependencies: {
				hono: '^4.0.0',
				react: '^19.0.0',
				'react-dom': '^19.0.0',
			},
		};
		await fs.writeFile(metaPath, JSON.stringify(meta));
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

// Create new project (needs to be outside project context)
app.post('/api/new-project', async (c) => {
	const environment = c.env;
	const id = environment.DO_FILESYSTEM.newUniqueId();
	const projectId = id.toString();
	const humanId = generateHumanId();
	return c.json({ projectId, url: `/p/${projectId}`, name: humanId });
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

		// Initialize project if needed (always checks sentinel file on disk)
		await ensureExampleProject(PROJECT_ROOT);

		// Refresh expiration timer
		await fsStub.refreshExpiration();

		// Handle WebSocket endpoint
		if (subPath === '/__ws' || subPath.startsWith('/__ws')) {
			const coordinatorId = c.env.DO_PROJECT_COORDINATOR.idFromName(`project:${projectId}`);
			const coordinatorStub = c.env.DO_PROJECT_COORDINATOR.get(coordinatorId);
			const wsUrl = new URL(c.req.url);
			wsUrl.pathname = '/ws';
			return coordinatorStub.fetch(new Request(wsUrl, c.req.raw));
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
			const previewService = getPreviewService(PROJECT_ROOT, projectId);
			const apiPath = subPath.replace('/preview', '');
			return previewService.handlePreviewAPI(c.req.raw, apiPath);
		}

		// Handle preview routes (serve user's frontend files)
		if (subPath === '/preview' || subPath.startsWith('/preview/')) {
			const basePrefix = `/p/${projectId}`;
			const previewService = getPreviewService(PROJECT_ROOT, projectId);
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
