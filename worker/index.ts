/**
 * Worker IDE - Main Entry Point
 *
 * Routing is split by subdomain:
 * - `<baseDomain>`                                        → App (SPA, API, WebSocket)
 * - `<projectId>-<token>.preview.<baseDomain>`            → Live preview of user projects
 *
 * Preview URLs contain an HMAC-signed time-bucket token that expires
 * after 1–2 hours, preventing permanent direct-link sharing.
 *
 * The base domain is derived at runtime from the Host header.
 */

import { env } from 'cloudflare:workers';
import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { mount, withMounts } from 'worker-fs-mount';

import { MAX_PROJECTS_PER_ORGANIZATION, PROJECT_INACTIVITY_DAYS, SOFT_DELETE_RETENTION_DAYS } from '@shared/constants';
import { buildAppOrigin, parseHost } from '@shared/domain';
import { generateHumanId } from '@shared/human-id';
import { validatePreviewToken } from '@shared/preview-token';
import { isValidProjectId } from '@shared/project-id';

import * as authSchema from './db/auth-schema';
import { createAuth } from './lib/auth';
import { requireAuth } from './lib/auth-middleware';
import { agentRunnerNamespace, coordinatorNamespace, filesystemNamespace } from './lib/durable-object-namespaces';
import { errorPage, previewExpiredPage } from './lib/error-page';
import { DEV_PREVIEW_SECRET } from './lib/preview-secret';
import { generateProjectId, toDurableObjectId } from './lib/project-id';
import { apiRoutes } from './routes';
import { orgRoutes } from './routes/org-routes';
import { GitClient } from './services/git-client';
import { PreviewService } from './services/preview-service';
import { collectChanges } from './services/working-tree';
import { getTemplate, getTemplateMetadata } from './templates';

import type { AppEnvironment, AuthedEnvironment } from './types';
import type { CommitFileEntry } from '@shared/git-types';

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
	const match = path.match(/^\/p\/([a-z\d]{1,50})(\/.*)$/);
	if (match) {
		return { projectId: match[1], subPath: match[2] };
	}
	const exactMatch = path.match(/^\/p\/([a-z\d]{1,50})$/);
	if (exactMatch) {
		return { projectId: exactMatch[1], subPath: '/' };
	}
	return undefined;
}

// =============================================================================
// Hono App
// =============================================================================

const app = new Hono<AuthedEnvironment>();

app.use('/api/*', cors());
app.use('/p/*/api/*', cors());

// =============================================================================
// better-auth handler — handles /api/auth/* (login, callback, session, etc.)
// =============================================================================

app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
	const url = new URL(c.req.url);
	const baseUrl = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);
	const auth = createAuth(
		{
			DB: c.env.DB,
			BETTER_AUTH_SECRET: c.env.BETTER_AUTH_SECRET,
			GITHUB_CLIENT_ID: c.env.GITHUB_CLIENT_ID,
			GITHUB_CLIENT_SECRET: c.env.GITHUB_CLIENT_SECRET,
		},
		baseUrl,
	);
	return auth.handler(c.req.raw);
});

// =============================================================================
// Auth middleware — protect all API routes except auth, templates, version
// =============================================================================

app.use('/api/new-project', requireAuth);
app.use('/api/clone-project', requireAuth);
app.use('/api/org/*', requireAuth);
app.use('/p/*/api/*', requireAuth);

// =============================================================================
// Org routes (authed, root-level)
// =============================================================================

app.route('/api', orgRoutes);

// =============================================================================
// Preview subdomain handler
// =============================================================================

/**
 * Detect cross-site hotlink requests using Sec-Fetch metadata headers.
 *
 * Blocks requests where `Sec-Fetch-Site` is `cross-site` and
 * `Sec-Fetch-Dest` is NOT a navigation destination. This prevents
 * external pages from hotlinking preview JS, CSS, images, etc. while
 * still allowing:
 *
 * - IDE `<iframe>` navigation (cross-site + dest=iframe → allowed)
 * - Top-level navigation / bookmark (cross-site + dest=document → allowed)
 * - Typed URL / bookmark (Sec-Fetch-Site=none → allowed)
 * - Same-origin requests within the preview (same-origin → allowed)
 * - Non-browser clients that don't send Sec-Fetch headers (allowed,
 *   since these headers are browser-only and cannot be spoofed by JS)
 */
function isHotlinkRequest(request: Request): boolean {
	const fetchSite = request.headers.get('Sec-Fetch-Site');
	const fetchDestination = request.headers.get('Sec-Fetch-Dest');

	// Only act when the browser explicitly tells us the request is cross-site.
	// Absence of the header (non-browser clients, older browsers) is allowed.
	if (fetchSite !== 'cross-site') return false;

	// Cross-site navigations are legitimate. `document` is used for top-level
	// navigations, `iframe` for <iframe> navigations (the IDE embeds the
	// preview in an iframe). Everything else (script, style, image, empty,
	// etc.) is a subresource fetch and treated as hotlinking.
	return fetchDestination !== 'document' && fetchDestination !== 'iframe';
}

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
 * Handle all requests on `<projectId>.preview.<baseDomain>`.
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
		fsId = toDurableObjectId(filesystemNamespace, projectId);
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

	// Block soft-deleted projects from being previewed
	const previewDatabase = drizzle(env.DB);
	const softDeletedRow = await previewDatabase
		.select({ id: authSchema.project.id })
		.from(authSchema.project)
		.where(and(eq(authSchema.project.id, projectId), isNotNull(authSchema.project.deletedAt)))
		.limit(1);
	if (softDeletedRow.length > 0) {
		return errorPage({
			heading: 'Project deleted',
			message: 'This project has been deleted.',
			homeUrl,
			status: 404,
		});
	}

	return withMounts(async () => {
		mount(PROJECT_ROOT, fsStub);

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
	const userId = c.get('userId');
	const organizationId = c.get('activeOrganizationId');
	if (!organizationId) {
		return c.json({ error: 'No active organization. Set an active organization first.' }, 400);
	}

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

	// Enforce per-org project limit
	const database = drizzle(c.env.DB);
	const existingProjects = await database
		.select({ id: authSchema.project.id })
		.from(authSchema.project)
		.where(and(eq(authSchema.project.organizationId, organizationId), isNull(authSchema.project.deletedAt)));
	if (existingProjects.length >= MAX_PROJECTS_PER_ORGANIZATION) {
		return c.json({ error: `Organization project limit reached (${MAX_PROJECTS_PER_ORGANIZATION}).` }, 400);
	}

	const doId = filesystemNamespace.newUniqueId();
	const projectId = generateProjectId(doId);
	const humanId = generateHumanId();

	await withMounts(async () => {
		const fsStub = filesystemNamespace.get(doId);
		mount(PROJECT_ROOT, fsStub);

		const fs = await import('node:fs/promises');
		await writeTemplateFiles(fs, PROJECT_ROOT, template.files, template.dependencies, humanId);
	});

	// Register project in D1
	const now = new Date();
	await database.insert(authSchema.project).values({
		id: projectId,
		organizationId,
		durableObjectHexId: doId.toString(),
		name: humanId,
		humanId,
		previewVisibility: 'public',
		createdByUserId: userId,
		createdAt: now,
		updatedAt: now,
	});

	// Create initial git commit via the git auxiliary worker
	const fsStub = filesystemNamespace.get(doId);
	c.executionCtx.waitUntil(
		(async () => {
			try {
				const gitClient = new GitClient(env.REPO_DO, projectId);
				let files: CommitFileEntry[] = [];

				await withMounts(async () => {
					mount(PROJECT_ROOT, fsStub);
					const fileSystem = await import('node:fs/promises');
					const { files: changedFiles } = await collectChanges(fileSystem, PROJECT_ROOT, []);
					files = changedFiles;
				});

				if (files.length > 0) {
					await gitClient.commitTree({
						files,
						message: 'Initial commit',
						author: { name: 'IDE User', email: 'user@example.com' },
					});
				}
			} catch (error) {
				console.error('Git initialization failed:', error);
			}
		})(),
	);

	return c.json({ projectId, url: `/p/${projectId}`, name: humanId });
});

app.post('/api/clone-project', async (c) => {
	const userId = c.get('userId');
	const organizationId = c.get('activeOrganizationId');
	if (!organizationId) {
		return c.json({ error: 'No active organization. Set an active organization first.' }, 400);
	}

	let sourceProjectId: string;
	try {
		const body: { sourceProjectId: string } = await c.req.json();
		sourceProjectId = body.sourceProjectId;
	} catch {
		return c.json({ error: 'Request body must contain sourceProjectId' }, 400);
	}

	if (!sourceProjectId || !isValidProjectId(sourceProjectId)) {
		return c.json({ error: 'Invalid source project ID.' }, 400);
	}

	let sourceId: DurableObjectId;
	try {
		sourceId = toDurableObjectId(filesystemNamespace, sourceProjectId);
	} catch {
		return c.json({ error: 'Invalid source project ID.' }, 400);
	}

	const sourceStub = filesystemNamespace.get(sourceId);
	if (!(await sourceStub.projectExists())) {
		return c.json({ error: 'Source project not found or not initialized' }, 404);
	}

	// Enforce per-org project limit
	const cloneDatabase = drizzle(c.env.DB);
	const existingCloneProjects = await cloneDatabase
		.select({ id: authSchema.project.id })
		.from(authSchema.project)
		.where(and(eq(authSchema.project.organizationId, organizationId), isNull(authSchema.project.deletedAt)));
	if (existingCloneProjects.length >= MAX_PROJECTS_PER_ORGANIZATION) {
		return c.json({ error: `Organization project limit reached (${MAX_PROJECTS_PER_ORGANIZATION}).` }, 400);
	}

	const newDoId = filesystemNamespace.newUniqueId();
	const newProjectId = generateProjectId(newDoId);
	const humanId = generateHumanId();

	await withMounts(async () => {
		const destinationStub = filesystemNamespace.get(newDoId);
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
	});

	// Register cloned project in D1
	const database = drizzle(c.env.DB);
	const now = new Date();
	await database.insert(authSchema.project).values({
		id: newProjectId,
		organizationId,
		durableObjectHexId: newDoId.toString(),
		name: humanId,
		humanId,
		previewVisibility: 'public',
		createdByUserId: userId,
		createdAt: now,
		updatedAt: now,
	});

	// Create initial git commit for cloned project via the git auxiliary worker
	const newFsStub = filesystemNamespace.get(newDoId);
	c.executionCtx.waitUntil(
		(async () => {
			try {
				const gitClient = new GitClient(env.REPO_DO, newProjectId);
				let files: CommitFileEntry[] = [];

				await withMounts(async () => {
					mount(PROJECT_ROOT, newFsStub);
					const fileSystem = await import('node:fs/promises');
					const { files: changedFiles } = await collectChanges(fileSystem, PROJECT_ROOT, []);
					files = changedFiles;
				});

				if (files.length > 0) {
					await gitClient.commitTree({
						files,
						message: 'Initial commit',
						author: { name: 'IDE User', email: 'user@example.com' },
					});
				}
			} catch (error) {
				console.error('Git initialization failed for clone:', error);
			}
		})(),
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
		fsId = toDurableObjectId(filesystemNamespace, projectId);
	} catch {
		if (subPath.startsWith('/api/') || subPath === '/__ws' || subPath.startsWith('/__ws')) {
			return c.notFound();
		}
		return env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
	}

	const isBackendRoute =
		subPath.startsWith('/api/') ||
		subPath === '/__ws' ||
		subPath.startsWith('/__ws') ||
		subPath === '/__agent' ||
		subPath.startsWith('/__agent');
	if (!isBackendRoute) {
		return env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
	}

	const fsStub = filesystemNamespace.get(fsId);
	if (!(await fsStub.projectExists())) {
		return c.notFound();
	}

	// Block soft-deleted projects from IDE access
	{
		const ideDatabase = drizzle(c.env.DB);
		const softDeletedIdeRow = await ideDatabase
			.select({ id: authSchema.project.id })
			.from(authSchema.project)
			.where(and(eq(authSchema.project.id, projectId), isNotNull(authSchema.project.deletedAt)))
			.limit(1);
		if (softDeletedIdeRow.length > 0) {
			return c.notFound();
		}
	}

	// Project-level authorization: verify the authenticated user is a member
	// of the organization that owns this project.
	const userId = c.get('userId');
	if (!userId) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	{
		const database = drizzle(c.env.DB);
		const projectRow = await database
			.select({ organizationId: authSchema.project.organizationId })
			.from(authSchema.project)
			.where(eq(authSchema.project.id, projectId))
			.limit(1);

		if (projectRow.length > 0) {
			const memberRow = await database
				.select({ id: authSchema.member.id })
				.from(authSchema.member)
				.where(and(eq(authSchema.member.organizationId, projectRow[0].organizationId), eq(authSchema.member.userId, userId)))
				.limit(1);

			if (memberRow.length === 0) {
				return c.json({ error: 'Forbidden' }, 403);
			}
		}
	}

	// Agent SDK WebSocket — forward to the AgentRunner DO.
	// The Agent class (from agents SDK) handles the WebSocket upgrade,
	// state sync, and @callable RPC natively.
	//
	// We must include the `x-partykit-room` header so partyserver can
	// identify the Agent's name on first connection (before it has been
	// persisted to storage). Without it, partyserver throws
	// "Missing namespace or room headers", which in the miniflare dev
	// environment causes an ERR_ASSERTION crash in #handleLoopback.
	if (subPath === '/__agent' || subPath.startsWith('/__agent')) {
		const agentId = agentRunnerNamespace.idFromName(`agent:${projectId}`);
		const agentStub = agentRunnerNamespace.get(agentId);
		const agentUrl = new URL(c.req.url);
		agentUrl.pathname = '/';
		const agentHeaders = new Headers(c.req.raw.headers);
		agentHeaders.set('x-partykit-room', `agent:${projectId}`);
		return agentStub.fetch(new Request(agentUrl, { ...c.req.raw, headers: agentHeaders }));
	}

	return withMounts(async () => {
		mount(PROJECT_ROOT, fsStub);

		if (subPath === '/__ws' || subPath.startsWith('/__ws')) {
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
			const wsUrl = new URL(c.req.url);
			wsUrl.pathname = '/ws';
			return coordinatorStub.fetch(new Request(wsUrl, c.req.raw));
		}

		const projectApp = new Hono<AppEnvironment>();

		projectApp.use('*', async (context, innerNext) => {
			context.set('userId', c.get('userId'));
			context.set('userSession', c.get('userSession'));
			context.set('activeOrganizationId', c.get('activeOrganizationId'));
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

		// Guard: reject WebSocket upgrade requests that don't match a known
		// WebSocket handler path before any routing can forward them to
		// env.ASSETS.fetch(). In the miniflare dev environment, forwarding a
		// WebSocket upgrade to the ASSETS node-service binding causes an
		// unrecoverable ERR_ASSERTION crash inside #handleLoopback because the
		// upgrade path calls #handleLoopback(req) without a `res` argument, but
		// the node-service branch unconditionally asserts that `res` is truthy.
		//
		// Valid WebSocket paths:
		//   - App domain:     /p/<projectId>/__ws   (ProjectCoordinator)
		//   - App domain:     /p/<projectId>/__agent (AgentRunner)
		//   - Preview domain: /__ws                  (ProjectCoordinator)
		if (request.headers.get('Upgrade') === 'websocket') {
			const isValidWebSocketPath =
				url.pathname === '/__ws' ||
				url.pathname.startsWith('/__ws/') ||
				/^\/p\/[^/]+\/__ws(\/|$)/.test(url.pathname) ||
				/^\/p\/[^/]+\/__agent(\/|$)/.test(url.pathname);

			if (!isValidWebSocketPath) {
				return new Response('WebSocket not supported on this path', { status: 404 });
			}
		}

		const parsed = parseHost(url.host);

		switch (parsed.type) {
			case 'preview': {
				const secret = env.PREVIEW_SECRET || DEV_PREVIEW_SECRET;
				const isValidToken = await validatePreviewToken(parsed.projectId, parsed.token, secret);
				if (!isValidToken) {
					return previewExpiredPage({ baseDomain: parsed.baseDomain, protocol: url.protocol });
				}

				// Block cross-site subresource requests (hotlinking).
				// Must run after token validation so we don't leak timing info
				// about whether a token is valid to cross-site probes.
				if (isHotlinkRequest(request)) {
					return new Response('Forbidden', { status: 403 });
				}

				// Rate-limit preview requests per project to prevent abuse.
				if (env.PREVIEW_RATE_LIMITER) {
					const { success } = await env.PREVIEW_RATE_LIMITER.limit({ key: parsed.projectId });
					if (!success) {
						return new Response('Too Many Requests', { status: 429 });
					}
				}

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

	/**
	 * Queue consumer for git push event notifications.
	 * When an external client pushes to the git worker, it publishes an event
	 * to the git-push-events queue. This handler broadcasts a git-status-changed
	 * message to all connected WebSocket clients for the affected project.
	 */
	async queue(batch: MessageBatch, _environment: Env, _executionContext: ExecutionContext): Promise<void> {
		for (const message of batch.messages) {
			try {
				const event = message.body;
				if (
					typeof event === 'object' &&
					event !== undefined &&
					event !== null &&
					'type' in event &&
					'repoId' in event &&
					event.type === 'push' &&
					typeof event.repoId === 'string'
				) {
					// Extract projectId from repoId (format: "ide/{projectId}")
					const projectId = event.repoId.startsWith('ide/') ? event.repoId.slice(4) : undefined;
					if (projectId) {
						const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
						const coordinatorStub = coordinatorNamespace.get(coordinatorId);
						await coordinatorStub.sendMessage({ type: 'git-status-changed' });
					}
				}
				message.ack();
			} catch (error) {
				console.error('Queue message processing failed:', error);
				message.retry();
			}
		}
	},

	/**
	 * Scheduled handler — runs daily via cron trigger (03:00 UTC).
	 *
	 * Two-phase project lifecycle cleanup:
	 * 1. Auto soft-delete: Projects older than PROJECT_INACTIVITY_DAYS (1 year)
	 *    that haven't been soft-deleted yet get soft-deleted automatically.
	 * 2. Permanent purge: Projects soft-deleted more than SOFT_DELETE_RETENTION_DAYS
	 *    (30 days) ago have their DO storage destroyed and D1 rows hard-deleted.
	 */
	async scheduled(_event: ScheduledEvent, environment: Env, _executionContext: ExecutionContext): Promise<void> {
		const database = drizzle(environment.DB);
		const now = new Date();

		// Phase 1: Auto soft-delete projects older than 1 year
		const inactivityCutoff = new Date(now.getTime() - PROJECT_INACTIVITY_DAYS * 24 * 60 * 60 * 1000);
		const staleProjects = await database
			.select({ id: authSchema.project.id })
			.from(authSchema.project)
			.where(and(isNull(authSchema.project.deletedAt), lte(authSchema.project.updatedAt, inactivityCutoff)));

		if (staleProjects.length > 0) {
			console.log(`Auto soft-deleting ${staleProjects.length} project(s) older than ${PROJECT_INACTIVITY_DAYS} days`);
			for (const project of staleProjects) {
				await database.update(authSchema.project).set({ deletedAt: now, updatedAt: now }).where(eq(authSchema.project.id, project.id));
			}
		}

		// Phase 2: Permanently purge projects soft-deleted more than 30 days ago
		const purgeCutoff = new Date(now.getTime() - SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
		const expiredProjects = await database
			.select({ id: authSchema.project.id, durableObjectHexId: authSchema.project.durableObjectHexId })
			.from(authSchema.project)
			.where(and(isNotNull(authSchema.project.deletedAt), lte(authSchema.project.deletedAt, purgeCutoff)));

		if (expiredProjects.length === 0) return;

		console.log(`Purging ${expiredProjects.length} soft-deleted project(s)`);

		for (const project of expiredProjects) {
			try {
				// Destroy the Durable Object filesystem via RPC.
				// destroyStorage() clears all alarms and wipes all stored data.
				const fsId = filesystemNamespace.idFromString(project.durableObjectHexId);
				const fsStub = filesystemNamespace.get(fsId);
				await fsStub.destroyStorage();
			} catch (error) {
				console.warn(`Failed to delete DO for project ${project.id}:`, error);
			}

			// Hard-delete the D1 row regardless of DO cleanup result
			await database.delete(authSchema.project).where(eq(authSchema.project.id, project.id));
			console.log(`Purged project ${project.id}`);
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
