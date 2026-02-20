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
import { DEFAULT_TEMPLATE_ID, getTemplate, getTemplateMetadata } from './templates';

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

/**
 * Regex for validating 64-character hexadecimal project IDs (Durable Object IDs).
 */
const PROJECT_ID_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Initialize a project with template files if not already initialized.
 * Uses a sentinel file on disk as the source of truth so that
 * re-initialization happens correctly after a DO storage wipe.
 *
 * If a `.template` marker file exists (written by the new-project endpoint),
 * the template specified in that file is used. Otherwise falls back to the
 * default template for backward compatibility.
 *
 * Returns `true` if the project was freshly initialized (first request),
 * signaling the caller to run git initialization via the DO.
 */
async function initializeProject(projectRoot: string): Promise<boolean> {
	// Dynamic import to allow alias resolution at build time
	const fs = await import('node:fs/promises');

	const sentinelPath = `${projectRoot}/.initialized`;
	try {
		await fs.readFile(sentinelPath);
		return false;
	} catch {
		// Not yet initialized
	}

	// Determine which template to use
	let templateId = DEFAULT_TEMPLATE_ID;
	const templateMarkerPath = `${projectRoot}/.template`;
	try {
		const marker = await fs.readFile(templateMarkerPath, 'utf8');
		if (marker.trim()) {
			templateId = marker.trim();
		}
	} catch {
		// No marker file — use default template
	}

	const template = getTemplate(templateId);
	if (template) {
		await writeTemplateFiles(fs, projectRoot, template.files, template.dependencies);
	} else {
		// Fallback to default if requested template doesn't exist
		const fallbackTemplate = getTemplate(DEFAULT_TEMPLATE_ID);
		if (!fallbackTemplate) {
			// Should never happen — write sentinel and bail
			await fs.writeFile(sentinelPath, '1');
			return false;
		}
		// Use fallback
		await writeTemplateFiles(fs, projectRoot, fallbackTemplate.files, fallbackTemplate.dependencies);
	}

	// Clean up the template marker file if it exists
	try {
		await fs.unlink(templateMarkerPath);
	} catch {
		// Ignore — file may not exist
	}

	await fs.writeFile(sentinelPath, '1');
	return true;
}

/**
 * Write template files and project metadata to the filesystem.
 * Only writes files that don't already exist (preserves manual edits).
 */
async function writeTemplateFiles(
	fs: typeof import('node:fs/promises'),
	projectRoot: string,
	files: Record<string, string>,
	dependencies: Record<string, string>,
): Promise<void> {
	for (const [filePath, content] of Object.entries(files)) {
		const fullPath = `${projectRoot}/${filePath}`;
		try {
			await fs.readFile(fullPath);
		} catch {
			const directory = fullPath.slice(0, fullPath.lastIndexOf('/'));
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(fullPath, content);
		}
	}

	// Write initial project metadata with template dependencies
	const metaPath = `${projectRoot}/.project-meta.json`;
	try {
		await fs.readFile(metaPath);
	} catch {
		const humanId = generateHumanId();
		const meta = {
			name: humanId,
			humanId,
			dependencies,
		};
		await fs.writeFile(metaPath, JSON.stringify(meta));
	}
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
 * Create a new project. Accepts an optional template ID in the request body.
 * If a template is specified, a `.template` marker file is written into the
 * new project's Durable Object so that `initializeProject()` uses the
 * correct template on first access.
 */
app.post('/api/new-project', async (c) => {
	const id = filesystemNamespace.newUniqueId();
	const projectId = id.toString();
	const humanId = generateHumanId();

	// Parse optional template from request body
	let templateId: string | undefined;
	try {
		const body: { template?: string } = await c.req.json();
		templateId = body.template;
	} catch {
		// No body or invalid JSON — use default template
	}

	// If a non-default template was requested, write a marker file
	// so initializeProject() knows which template to use
	if (templateId && templateId !== DEFAULT_TEMPLATE_ID) {
		// Validate the template exists
		const template = getTemplate(templateId);
		if (!template) {
			return c.json({ error: `Unknown template: ${templateId}` }, 400);
		}

		await withMounts(async () => {
			const fsStub = filesystemNamespace.get(id);
			mount(PROJECT_ROOT, fsStub);

			const fs = await import('node:fs/promises');
			await fs.writeFile(`${PROJECT_ROOT}/.template`, templateId);
		});
	}

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

	const newId = filesystemNamespace.newUniqueId();
	const newProjectId = newId.toString();
	const humanId = generateHumanId();

	try {
		await withMounts(async () => {
			const sourceStub = filesystemNamespace.get(filesystemNamespace.idFromString(sourceProjectId));
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
			const meta: { name: string; humanId: string; dependencies: Record<string, string> } = {
				name: humanId,
				humanId,
				dependencies: {},
			};
			try {
				const sourceMetaRaw = await fs.readFile('/source/.project-meta.json', 'utf8');
				const sourceMeta: { dependencies?: Record<string, string> } = JSON.parse(sourceMetaRaw);
				meta.dependencies = sourceMeta.dependencies ?? {};
			} catch {
				// Use empty dependencies if source has no metadata
			}

			await fs.writeFile('/destination/.project-meta.json', JSON.stringify(meta));
			await fs.writeFile('/destination/.initialized', '1');

			// Remove the template marker from the clone (if it somehow exists)
			try {
				await fs.unlink('/destination/.template');
			} catch {
				// Ignore
			}

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

	return withMounts(async () => {
		const fsId = filesystemNamespace.idFromString(projectId);
		const fsStub = filesystemNamespace.get(fsId);
		mount(PROJECT_ROOT, fsStub);

		// Initialize project if needed (always checks sentinel file on disk)
		const needsGitInit = await initializeProject(PROJECT_ROOT);

		// Run git init inside the DO — single-threaded, no race conditions.
		// This is safe to fire-and-forget because the DO serializes all RPC
		// calls. Any subsequent git API request will queue behind this.
		if (needsGitInit) {
			c.executionCtx.waitUntil(
				fsStub.gitInit().catch((error) => {
					console.error('Git initialization failed:', error);
				}),
			);
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
const CLONE_SKIP_ENTRIES = new Set(['.initialized', '.project-meta.json', '.template', '.agent', '.git']);

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
