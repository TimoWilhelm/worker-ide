/**
 * Worker IDE - Main Entry Point
 *
 * Routing is split by subdomain:
 * - `<baseDomain>`                          → App (SPA, API, WebSocket)
 * - `<encoded-id>.preview.<baseDomain>`     → Live preview of user projects
 *
 * The base domain is derived at runtime from the Host header.
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { mount, withMounts } from 'worker-fs-mount';

import { buildAppOrigin, parseHost } from '@shared/domain';
import { generateHumanId } from '@shared/human-id';

import { coordinatorNamespace, filesystemNamespace } from './lib/durable-object-namespaces';
import { errorPage } from './lib/error-page';
import { apiRoutes } from './routes';
import { PreviewService } from './services/preview-service';
import { getTemplate, getTemplateMetadata } from './templates';

import type { AppEnvironment } from './types';

// =============================================================================
// Preview Service Cache
// =============================================================================

const MAX_PREVIEW_SERVICE_CACHE_SIZE = 100;
const previewServiceCache = new Map<string, PreviewService>();

function getPreviewService(projectRoot: string, projectId: string): PreviewService {
	let service = previewServiceCache.get(projectId);
	if (service) {
		previewServiceCache.delete(projectId);
		previewServiceCache.set(projectId, service);
		return service;
	}
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

// =============================================================================
// Re-exports for wrangler
// =============================================================================

export { AgentRunner, DurableObjectFilesystem, ProjectCoordinator } from './durable';
export { LogTailer } from './services/log-tailer';

// =============================================================================
// Constants
// =============================================================================

const PROJECT_ROOT = '/project';
const PROJECT_ID_PATTERN = /^[a-f\d]{64}$/i;

// =============================================================================
// Helpers
// =============================================================================

async function writeTemplateFiles(
	fs: typeof import('node:fs/promises'),
	projectRoot: string,
	files: Record<string, string>,
	dependencies: Record<string, string>,
	humanId: string,
): Promise<void> {
	for (const [filePath, content] of Object.entries(files)) {
		const fullPath = `${projectRoot}/${filePath}`;
		const directory = fullPath.slice(0, fullPath.lastIndexOf('/'));
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(fullPath, content);
	}

	const meta = { name: humanId, humanId, dependencies };
	await fs.writeFile(`${projectRoot}/.project-meta.json`, JSON.stringify(meta));
	await fs.writeFile(`${projectRoot}/.initialized`, '1');
}

function parseProjectRoute(path: string): { projectId: string; subPath: string } | undefined {
	const match = path.match(/^\/p\/([a-f\d]{64})(\/.*)$/i);
	if (match) {
		return { projectId: match[1].toLowerCase(), subPath: match[2] };
	}
	const exactMatch = path.match(/^\/p\/([a-f\d]{64})$/i);
	if (exactMatch) {
		return { projectId: exactMatch[1].toLowerCase(), subPath: '/' };
	}
	return undefined;
}

// =============================================================================
// Hono App
// =============================================================================

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());
app.use('/p/*/api/*', cors());

// =============================================================================
// Preview subdomain handler
// =============================================================================

/**
 * Paths that belong to the IDE's dev infrastructure (Vite, PWA, etc.)
 * rather than user project files. When these are requested on a preview
 * subdomain (due to the browser's service worker, favicon probe, etc.)
 * we delegate to the asset pipeline instead of the preview filesystem.
 */
const DEV_INFRASTRUCTURE_PREFIXES = ['/@vite/', '/@vite-plugin-', '/@fs/', '/@id/', '/.well-known/', '/workbox-'];
const DEV_INFRASTRUCTURE_EXACT = new Set(['/@react-refresh', '/dev-sw.js', '/sw.js', '/sw.js.map']);

function isDevelopmentInfrastructurePath(pathname: string): boolean {
	if (DEV_INFRASTRUCTURE_EXACT.has(pathname)) return true;
	return DEV_INFRASTRUCTURE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Handle all requests on `<encoded-id>.preview.<baseDomain>`.
 * The request path maps directly to the user's project filesystem.
 */
async function handlePreviewRequest(request: Request, projectId: string): Promise<Response> {
	const url = new URL(request.url);

	if (isDevelopmentInfrastructurePath(url.pathname)) {
		return env.ASSETS.fetch(request);
	}
	const appOrigin = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);

	const homeUrl = `${appOrigin}/`;

	let fsId: DurableObjectId;
	try {
		fsId = filesystemNamespace.idFromString(projectId);
	} catch {
		return errorPage({
			heading: 'Invalid project',
			message: 'The project ID in this URL is not valid.',
			homeUrl,
			status: 400,
		});
	}

	const fsStub = filesystemNamespace.get(fsId);
	if (!(await fsStub.projectExists())) {
		return errorPage({
			heading: 'Project not found',
			message: "The project you're looking for doesn't exist or has expired.",
			homeUrl,
			status: 404,
		});
	}

	return withMounts(async () => {
		mount(PROJECT_ROOT, fsStub);
		await fsStub.refreshExpiration();

		if (url.pathname === '/__ws' || url.pathname.startsWith('/__ws')) {
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
			const wsUrl = new URL(request.url);
			wsUrl.pathname = '/ws';
			return coordinatorStub.fetch(new Request(wsUrl, request));
		}

		const previewService = getPreviewService(PROJECT_ROOT, projectId);
		const assetSettings = await previewService.loadAssetSettings();

		if (url.pathname.startsWith('/api/')) {
			return previewService.handlePreviewAPI(request, url.pathname);
		}

		if (previewService.matchesRunWorkerFirst(url.pathname, assetSettings.run_worker_first)) {
			return previewService.handlePreviewAPI(request, url.pathname);
		}

		return previewService.serveFile(request, appOrigin, assetSettings);
	});
}

// =============================================================================
// Root-level API routes
// =============================================================================

app.post('/api/new-project', async (c) => {
	let templateId: string;
	try {
		const body: { template: string } = await c.req.json();
		templateId = body.template;
	} catch {
		return c.json({ error: 'Request body must contain a template ID' }, 400);
	}

	if (!templateId) {
		return c.json({ error: 'Request body must contain a template ID' }, 400);
	}

	const template = getTemplate(templateId);
	if (!template) {
		return c.json({ error: `Unknown template: ${templateId}` }, 400);
	}

	const id = filesystemNamespace.newUniqueId();
	const projectId = id.toString();
	const humanId = generateHumanId();

	await withMounts(async () => {
		const fsStub = filesystemNamespace.get(id);
		mount(PROJECT_ROOT, fsStub);

		const fs = await import('node:fs/promises');
		await writeTemplateFiles(fs, PROJECT_ROOT, template.files, template.dependencies, humanId);
	});

	const fsStub = filesystemNamespace.get(id);
	c.executionCtx.waitUntil(
		fsStub.gitInit().catch((error) => {
			console.error('Git initialization failed:', error);
		}),
	);

	return c.json({ projectId, url: `/p/${projectId}`, name: humanId });
});

app.post('/api/clone-project', async (c) => {
	let sourceProjectId: string;
	try {
		const body: { sourceProjectId: string } = await c.req.json();
		sourceProjectId = body.sourceProjectId;
	} catch {
		return c.json({ error: 'Request body must contain sourceProjectId' }, 400);
	}

	if (!sourceProjectId || !PROJECT_ID_PATTERN.test(sourceProjectId)) {
		return c.json({ error: 'Invalid source project ID. Must be a 64-character hex string.' }, 400);
	}

	sourceProjectId = sourceProjectId.toLowerCase();

	let sourceId: DurableObjectId;
	try {
		sourceId = filesystemNamespace.idFromString(sourceProjectId);
	} catch {
		return c.json({ error: 'Invalid source project ID.' }, 400);
	}

	const sourceStub = filesystemNamespace.get(sourceId);
	if (!(await sourceStub.projectExists())) {
		return c.json({ error: 'Source project not found or not initialized' }, 404);
	}

	const newId = filesystemNamespace.newUniqueId();
	const newProjectId = newId.toString();
	const humanId = generateHumanId();

	await withMounts(async () => {
		const destinationStub = filesystemNamespace.get(newId);
		mount('/source', sourceStub);
		mount('/destination', destinationStub);

		const fs = await import('node:fs/promises');

		await copyDirectoryRecursive(fs, '/source', '/destination');

		const meta: { name: string; humanId: string; dependencies: Record<string, string>; assetSettings?: Record<string, unknown> } = {
			name: humanId,
			humanId,
			dependencies: {},
		};
		try {
			const sourceMetaRaw = await fs.readFile('/source/.project-meta.json', 'utf8');
			const sourceMeta: { dependencies?: Record<string, string>; assetSettings?: Record<string, unknown> } = JSON.parse(sourceMetaRaw);
			meta.dependencies = sourceMeta.dependencies ?? {};
			if (sourceMeta.assetSettings) {
				meta.assetSettings = sourceMeta.assetSettings;
			}
		} catch {
			// Use empty dependencies if source has no metadata
		}

		await fs.writeFile('/destination/.project-meta.json', JSON.stringify(meta));
		await fs.writeFile('/destination/.initialized', '1');
		await destinationStub.refreshExpiration();
	});

	const newFsStub = filesystemNamespace.get(newId);
	c.executionCtx.waitUntil(
		newFsStub.gitInit().catch((error) => {
			console.error('Git initialization failed for clone:', error);
		}),
	);

	return c.json({ projectId: newProjectId, url: `/p/${newProjectId}`, name: humanId });
});

app.get('/api/templates', (c) => {
	return c.json({ templates: getTemplateMetadata() });
});

app.get('/api/version', (c) => {
	const metadata = env.CF_VERSION_METADATA;
	return c.json({
		id: metadata.id,
		tag: metadata.tag,
		timestamp: metadata.timestamp,
	});
});

// =============================================================================
// Project-scoped IDE routes
// =============================================================================

app.all('/p/:projectId/*', async (c) => {
	const path = new URL(c.req.url).pathname;
	const projectRoute = parseProjectRoute(path);

	if (!projectRoute) {
		return env.ASSETS.fetch(c.req.raw);
	}

	const { projectId, subPath } = projectRoute;

	let fsId: DurableObjectId;
	try {
		fsId = filesystemNamespace.idFromString(projectId);
	} catch {
		// Invalid Durable Object ID — for API/WS routes, return 404.
		// For page navigations, serve the SPA (shows ProjectNotFound via ProjectGate).
		if (subPath.startsWith('/api/') || subPath === '/__ws' || subPath.startsWith('/__ws')) {
			return c.notFound();
		}
		return env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
	}

	const isBackendRoute = subPath.startsWith('/api/') || subPath === '/__ws' || subPath.startsWith('/__ws');
	if (!isBackendRoute) {
		return env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
	}

	const fsStub = filesystemNamespace.get(fsId);
	if (!(await fsStub.projectExists())) {
		return c.notFound();
	}

	return withMounts(async () => {
		mount(PROJECT_ROOT, fsStub);
		await fsStub.refreshExpiration();

		if (subPath === '/__ws' || subPath.startsWith('/__ws')) {
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
			const wsUrl = new URL(c.req.url);
			wsUrl.pathname = '/ws';
			return coordinatorStub.fetch(new Request(wsUrl, c.req.raw));
		}

		const projectApp = new Hono<AppEnvironment>();

		projectApp.use('*', async (context, innerNext) => {
			context.set('projectId', projectId);
			context.set('projectRoot', PROJECT_ROOT);
			context.set('fsStub', fsStub);
			await innerNext();
		});

		projectApp.route('/api', apiRoutes);

		const apiUrl = new URL(c.req.url);
		apiUrl.pathname = subPath;

		return projectApp.fetch(new Request(apiUrl, c.req.raw), env, c.executionCtx);
	});
});

app.get('/p/:projectId', async (c) => {
	return env.ASSETS.fetch(c.req.raw);
});

// Fallback to static assets
app.all('*', (c) => {
	return env.ASSETS.fetch(c.req.raw);
});

// =============================================================================
// Top-level fetch handler — routes by subdomain
// =============================================================================

export default {
	async fetch(request: Request, environment: Env, executionContext: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const parsed = parseHost(url.host);

		switch (parsed.type) {
			case 'preview': {
				return handlePreviewRequest(request, parsed.projectId);
			}

			case 'app': {
				return app.fetch(request, environment, executionContext);
			}

			case 'unknown': {
				const homeUrl = `${url.protocol}//${parsed.baseDomain}/`;
				return errorPage({
					heading: 'Page not found',
					message: "The page you're looking for doesn't exist.",
					homeUrl,
					status: 404,
				});
			}
		}
	},
};

// =============================================================================
// Clone helpers
// =============================================================================

const CLONE_SKIP_ENTRIES = new Set(['.initialized', '.project-meta.json', '.agent', '.git']);

async function copyDirectoryRecursive(fs: typeof import('node:fs/promises'), source: string, destination: string): Promise<void> {
	const entries = await fs.readdir(source, { withFileTypes: true });

	for (const entry of entries) {
		if (CLONE_SKIP_ENTRIES.has(entry.name)) {
			continue;
		}

		const sourcePath = `${source}/${entry.name}`;
		const destinationPath = `${destination}/${entry.name}`;

		if (entry.isDirectory()) {
			await fs.mkdir(destinationPath, { recursive: true });
			await copyDirectoryRecursive(fs, sourcePath, destinationPath);
		} else {
			const content = await fs.readFile(sourcePath);
			const directory = destinationPath.slice(0, destinationPath.lastIndexOf('/'));
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(destinationPath, content);
		}
	}
}
