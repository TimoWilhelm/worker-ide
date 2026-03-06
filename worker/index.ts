/**
 * Worker IDE - Main Entry Point
 *
 * This is the main Cloudflare Worker entry point using Hono for routing.
 * The worker handles:
 * - API routes for file operations, sessions, snapshots
 * - Project-scoped routes (/p/:projectId/*)
 * - Project WebSocket connections (HMR, collaboration, server events)
 * - Preview serving for user projects
 * - Template listing and project cloning (root-level API)
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { mount, withMounts } from 'worker-fs-mount';

import { generateHumanId } from '@shared/human-id';

import { coordinatorNamespace, filesystemNamespace } from './lib/durable-object-namespaces';
import { apiRoutes } from './routes';
import { PreviewService } from './services/preview-service';
import { getTemplate, getTemplateMetadata } from './templates';

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
export { AgentRunner, DurableObjectFilesystem, ProjectCoordinator } from './durable';

// Re-export LogTailer so it's available on ctx.exports for WorkerLoader tails
export { LogTailer } from './services/log-tailer';

const PROJECT_ROOT = '/project';

/**
 * Regex for validating 64-character hexadecimal project IDs (Durable Object IDs).
 */
const PROJECT_ID_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Check whether a project exists by looking for the `.initialized` sentinel.
 * Projects are fully initialized at creation time by `/api/new-project` or
 * `/api/clone-project`, so if the sentinel is missing the project was never
 * created.
 */
async function projectExists(projectRoot: string): Promise<boolean> {
	const fs = await import('node:fs/promises');
	try {
		await fs.readFile(`${projectRoot}/.initialized`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write template files and project metadata to the filesystem.
 */
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

	// Write initial project metadata with template dependencies
	const meta = { name: humanId, humanId, dependencies };
	await fs.writeFile(`${projectRoot}/.project-meta.json`, JSON.stringify(meta));

	// Mark project as initialized
	await fs.writeFile(`${projectRoot}/.initialized`, '1');
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

// =============================================================================
// Root-level API routes (outside project scope)
// =============================================================================

/**
 * POST /api/new-project
 *
 * Create a new project. Requires a `template` ID in the request body.
 * The project is fully initialized (template files written, `.initialized`
 * sentinel set) before the response is returned.
 */
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

	// Run git init inside the DO — single-threaded, no race conditions.
	const fsStub = filesystemNamespace.get(id);
	c.executionCtx.waitUntil(
		fsStub.gitInit().catch((error) => {
			console.error('Git initialization failed:', error);
		}),
	);

	return c.json({ projectId, url: `/p/${projectId}`, name: humanId });
});

/**
 * POST /api/clone-project
 *
 * Clone an existing project by copying all files from the source project
 * into a new Durable Object. Uses streaming file-by-file copy to stay
 * within Cloudflare Workers memory limits (128 MB per isolate).
 *
 * Limits analysis:
 * - CPU time: Mostly I/O wait (DO reads/writes), well under 30s default
 * - Subrequests: ~2 per file (read + write) + directory ops, well under 10,000
 * - Memory: Files are copied one at a time, peak = largest single file
 * - Connections: 2 DO stubs mounted simultaneously (within 6 connection limit)
 */
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

	const newId = filesystemNamespace.newUniqueId();
	const newProjectId = newId.toString();
	const humanId = generateHumanId();

	try {
		await withMounts(async () => {
			const sourceStub = filesystemNamespace.get(sourceId);
			const destinationStub = filesystemNamespace.get(newId);
			mount('/source', sourceStub);
			mount('/destination', destinationStub);

			const fs = await import('node:fs/promises');

			// Verify source project exists by checking for the sentinel file
			try {
				await fs.readFile('/source/.initialized');
			} catch {
				throw new Error('SOURCE_NOT_FOUND');
			}

			// Copy all files from source to destination, file by file.
			// This is memory-efficient: only one file's content is in memory at a time.
			await copyDirectoryRecursive(fs, '/source', '/destination');

			// Write fresh metadata for the cloned project
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

			// Refresh expiration on the new project
			await destinationStub.refreshExpiration();
		});
	} catch (error) {
		if (error instanceof Error && error.message === 'SOURCE_NOT_FOUND') {
			return c.json({ error: 'Source project not found or not initialized' }, 404);
		}
		throw error;
	}

	// Run git initialization inside the DO — single-threaded, no race conditions.
	const newFsStub = filesystemNamespace.get(newId);
	c.executionCtx.waitUntil(
		newFsStub.gitInit().catch((error) => {
			console.error('Git initialization failed for clone:', error);
		}),
	);

	return c.json({ projectId: newProjectId, url: `/p/${newProjectId}`, name: humanId });
});

/**
 * GET /api/templates
 *
 * Returns metadata for all available project templates (without file contents).
 * Used by the landing page to display template cards.
 */
app.get('/api/templates', (c) => {
	return c.json({ templates: getTemplateMetadata() });
});

/**
 * GET /api/version
 *
 * Returns the Cloudflare deployment version metadata.
 * Used by the frontend to display the deployment version alongside the
 * build-time git commit hash injected via Vite's `define`.
 */
app.get('/api/version', (c) => {
	const metadata = env.CF_VERSION_METADATA;
	return c.json({
		id: metadata.id,
		tag: metadata.tag,
		timestamp: metadata.timestamp,
	});
});

// =============================================================================
// Project-scoped routes
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
		return c.notFound();
	}

	return withMounts(async () => {
		const fsStub = filesystemNamespace.get(fsId);
		mount(PROJECT_ROOT, fsStub);

		// Verify the project exists (was created via /api/new-project or /api/clone-project)
		if (!(await projectExists(PROJECT_ROOT))) {
			return c.notFound();
		}

		// Refresh expiration timer
		await fsStub.refreshExpiration();

		// Handle WebSocket endpoint
		if (subPath === '/__ws' || subPath.startsWith('/__ws')) {
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
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

			return projectApp.fetch(new Request(apiUrl, c.req.raw), env, c.executionCtx);
		}

		// Handle preview routes (serve user's frontend files and backend code)
		if (subPath === '/preview' || subPath.startsWith('/preview/')) {
			const basePrefix = `/p/${projectId}`;
			const previewService = getPreviewService(PROJECT_ROOT, projectId);
			const previewPath = subPath === '/preview' ? '/' : subPath.replace(/^\/preview/, '');

			// Always route /api/* paths to the user's backend worker code
			if (previewPath.startsWith('/api/')) {
				return previewService.handlePreviewAPI(c.req.raw, previewPath);
			}

			// Load asset settings once for both run_worker_first check and serveFile
			const assetSettings = await previewService.loadAssetSettings();

			// Check run_worker_first setting to decide if the user's worker should handle this path
			if (previewService.matchesRunWorkerFirst(previewPath, assetSettings.run_worker_first)) {
				// run_worker_first matched — route to user's backend code first
				return previewService.handlePreviewAPI(c.req.raw, previewPath);
			}

			// Serve static file
			const previewUrl = new URL(c.req.url);
			previewUrl.pathname = previewPath;
			return previewService.serveFile(new Request(previewUrl, c.req.raw), `${basePrefix}/preview`, assetSettings);
		}

		// Serve the SPA for all other routes
		return env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
	});
});

// Project root without trailing content
app.get('/p/:projectId', async (c) => {
	return env.ASSETS.fetch(c.req.raw);
});

// Fallback to static assets
app.all('*', (c) => {
	return env.ASSETS.fetch(c.req.raw);
});

export default app;

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Hidden entries that should not be copied during cloning.
 * These are internal sentinel/metadata files managed by the IDE.
 */
const CLONE_SKIP_ENTRIES = new Set(['.initialized', '.project-meta.json', '.agent', '.git']);

/**
 * Recursively copy files from source to destination, one file at a time.
 *
 * This approach is memory-efficient because only one file's content is held
 * in memory at any point. This avoids hitting the 128 MB isolate memory limit
 * even for projects with many or large files.
 *
 * Each file read/write goes through worker-fs-mount to the Durable Object,
 * which counts as a subrequest. For a project with N files, this uses
 * approximately 2N + D subrequests (N reads + N writes + D directory reads),
 * well within the 10,000 default subrequest limit.
 */
async function copyDirectoryRecursive(fs: typeof import('node:fs/promises'), source: string, destination: string): Promise<void> {
	const entries = await fs.readdir(source, { withFileTypes: true });

	for (const entry of entries) {
		// Skip internal IDE files
		if (CLONE_SKIP_ENTRIES.has(entry.name)) {
			continue;
		}

		const sourcePath = `${source}/${entry.name}`;
		const destinationPath = `${destination}/${entry.name}`;

		if (entry.isDirectory()) {
			await fs.mkdir(destinationPath, { recursive: true });
			await copyDirectoryRecursive(fs, sourcePath, destinationPath);
		} else {
			// Read and write one file at a time to bound memory usage
			const content = await fs.readFile(sourcePath);
			const directory = destinationPath.slice(0, destinationPath.lastIndexOf('/'));
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(destinationPath, content);
		}
	}
}
