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

import { getCookies } from 'better-auth/cookies';
import { env } from 'cloudflare:workers';
import { and, eq, gt, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serialize, serializeSigned } from 'hono/utils/cookie';
import { mount, withMounts } from 'worker-fs-mount';
import { z } from 'zod';

import { PROJECT_INACTIVITY_DAYS, SOFT_DELETE_RETENTION_DAYS } from '@shared/constants';
import { buildAppOrigin, parseHost } from '@shared/domain';
import { resolveOrgLimitsFromRows } from '@shared/entitlements';
import { generateHumanId } from '@shared/human-id';
import { validatePreviewToken } from '@shared/preview-token';
import { isValidProjectId } from '@shared/project-id';

import * as authSchema from './db/auth-schema';
import { createAuth } from './lib/auth';
import { requireAuth } from './lib/auth-middleware';
import { agentRunnerNamespace, coordinatorNamespace, filesystemNamespace } from './lib/durable-object-namespaces';
import { queryEntitlements } from './lib/entitlements';
import { errorPage, previewExpiredPage } from './lib/error-page';
import { DEV_PREVIEW_SECRET } from './lib/preview-secret';
import { generateProjectId, toDurableObjectId } from './lib/project-id';
import { apiRoutes } from './routes';
import { orgRoutes } from './routes/org-routes';
import { transferRoutes } from './routes/transfer-routes';
import { userRoutes } from './routes/user-routes';
import { GitClient } from './services/git-client';
import { collectChanges } from './services/working-tree';
import { getTemplate, getTemplateMetadata } from './templates';

import type { PreviewService } from './services/preview-service';
import type { AppEnvironment, AuthedEnvironment } from './types';
import type { CommitFileEntry } from '@shared/git-types';

// =============================================================================
// Preview Service Cache
//
// Module-level LRU cache for PreviewService instances. This is safe because
// PreviewService is stateless — it only holds projectRoot and projectId strings.
// All data (files, settings, dependencies) is read fresh from the filesystem
// on every request. The cache avoids repeated dynamic imports of the
// PreviewService module on hot paths.
// =============================================================================

const MAX_PREVIEW_SERVICE_CACHE_SIZE = 100;
const previewServiceCache = new Map<string, PreviewService>();

async function getPreviewService(projectRoot: string, projectId: string): Promise<PreviewService> {
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
	// Lazy-import PreviewService to avoid pulling in chobitsu (which uses eval())
	// at module load time. This keeps the worker entrypoint importable in test
	// environments where eval() is blocked (workerd vitest pool).
	const { PreviewService: PreviewServiceClass } = await import('./services/preview-service');
	service = new PreviewServiceClass(projectRoot, projectId);
	previewServiceCache.set(projectId, service);
	return service;
}

// =============================================================================
// Re-exports for wrangler
// =============================================================================

export { AgentRunner, DurableObjectFilesystem, ProjectCoordinatorV2 } from './durable';
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
	humanId: string,
): Promise<void> {
	for (const [filePath, content] of Object.entries(files)) {
		const fullPath = `${projectRoot}/${filePath}`;
		const directory = fullPath.slice(0, fullPath.lastIndexOf('/'));
		await fs.mkdir(directory, { recursive: true });
		// Stamp the generated human ID into package.json so the project
		// name shown in the IDE header matches the DB record.
		if (filePath === 'package.json') {
			const packageJson: Record<string, unknown> = JSON.parse(content);
			packageJson.name = humanId;
			await fs.writeFile(fullPath, JSON.stringify(packageJson, undefined, '\t') + '\n');
		} else {
			await fs.writeFile(fullPath, content);
		}
	}

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

app.use(
	'/api/*',
	cors({
		origin: (origin, c) => {
			const { baseDomain } = parseHost(new URL(c.req.url).host);
			const appOrigin = buildAppOrigin(baseDomain, new URL(c.req.url).protocol);
			return origin === appOrigin ? origin : undefined;
		},
		credentials: true,
	}),
);
app.use(
	'/p/*/api/*',
	cors({
		origin: (origin, c) => {
			const { baseDomain } = parseHost(new URL(c.req.url).host);
			const appOrigin = buildAppOrigin(baseDomain, new URL(c.req.url).protocol);
			return origin === appOrigin ? origin : undefined;
		},
		credentials: true,
	}),
);

// =============================================================================
// Health check (public, no auth required)
// =============================================================================

app.get('/api/health', (c) => c.json({ ok: true }));

// =============================================================================
// better-auth handler — handles /api/auth/* (login, callback, session, etc.)
//
// In dev mode, better-auth's internal loopback HTTP calls crash inside
// miniflare, so we intercept the session endpoint and resolve it directly
// from D1. This block is dead-code-eliminated from production builds.
// =============================================================================

if (import.meta.env.DEV) {
	app.get('/api/auth/get-session', async (c) => {
		const { resolveDevelopmentSession } = await import('./lib/development-session');
		const result = await resolveDevelopmentSession(c.env.DB, c.req.raw.headers);
		if (!result) return c.json({ error: 'Unauthorized' }, 401);
		return c.json(result);
	});

	app.get('/api/auth/list-organizations', async (c) => {
		const { resolveDevelopmentSession } = await import('./lib/development-session');
		const result = await resolveDevelopmentSession(c.env.DB, c.req.raw.headers);
		if (!result) return c.json({ error: 'Unauthorized' }, 401);

		const database = drizzle(c.env.DB);
		const memberships = await database
			.select({ organizationId: authSchema.member.organizationId })
			.from(authSchema.member)
			.where(eq(authSchema.member.userId, result.user.id));

		const organizationIds = memberships.map((m) => m.organizationId);
		if (organizationIds.length === 0) return c.json([]);

		const organizations = await database.select().from(authSchema.organization).where(inArray(authSchema.organization.id, organizationIds));
		return c.json(organizations);
	});

	app.post('/api/auth/organization/set-active', async (c) => {
		const { resolveDevelopmentSession } = await import('./lib/development-session');
		const result = await resolveDevelopmentSession(c.env.DB, c.req.raw.headers);
		if (!result) return c.json({ error: 'Unauthorized' }, 401);

		const body = await c.req.json<{ organizationId: string }>();
		if (!body.organizationId || typeof body.organizationId !== 'string') {
			return c.json({ error: 'Missing organizationId' }, 400);
		}
		const database = drizzle(c.env.DB);

		const membership = await database
			.select({ id: authSchema.member.id })
			.from(authSchema.member)
			.where(and(eq(authSchema.member.organizationId, body.organizationId), eq(authSchema.member.userId, result.user.id)))
			.limit(1);
		if (membership.length === 0) return c.json({ error: 'Forbidden' }, 403);

		const now = new Date();
		await database
			.update(authSchema.session)
			.set({ activeOrganizationId: body.organizationId, updatedAt: now })
			.where(eq(authSchema.session.id, result.session.id));

		return c.json({ ...result.session, activeOrganizationId: body.organizationId, updatedAt: now });
	});
}

// Redeem a one-time session exchange code
const exchangeCodeSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[\w-]+$/);

app.get('/api/auth/session/exchange', async (c) => {
	const codeResult = exchangeCodeSchema.safeParse(c.req.query('code'));
	if (!codeResult.success) return c.redirect('/');

	const code = codeResult.data;
	const database = drizzle(c.env.DB);
	const now = new Date();
	const identifier = `session-exchange:${code}`;

	// Atomic delete-and-return to prevent the same code from being redeemed twice
	const [row] = await database
		.delete(authSchema.verification)
		.where(and(eq(authSchema.verification.identifier, identifier), gt(authSchema.verification.expiresAt, now)))
		.returning({ value: authSchema.verification.value });

	if (!row) return c.redirect('/');

	const url = new URL(c.req.url);
	const baseUrl = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);
	const { sessionToken, sessionData } = getCookies({ baseURL: baseUrl, secret: c.env.BETTER_AUTH_SECRET });
	const { prefix: _, ...cookieOptions } = sessionToken.attributes;
	const setSessionCookie = await serializeSigned(sessionToken.name, row.value, c.env.BETTER_AUTH_SECRET, cookieOptions);

	// Expire the session_data cache cookie so getSession falls through to the
	// DB lookup with the new token instead of returning the stale cached session.
	const { prefix: __, ...dataCookieOptions } = sessionData.attributes;
	const expireDataCookie = serialize(sessionData.name, '', { ...dataCookieOptions, maxAge: 0 });

	const headers = new Headers();
	headers.set('Location', '/');
	headers.append('Set-Cookie', setSessionCookie);
	headers.append('Set-Cookie', expireDataCookie);

	return new Response(undefined, { status: 302, headers });
});

// Admin plugin HTTP endpoints are not exposed
app.all('/api/auth/admin/*', (c) => c.notFound());

app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
	const url = new URL(c.req.url);
	const baseUrl = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);
	const auth = createAuth(
		{
			DB: c.env.DB,
			BETTER_AUTH_SECRET: c.env.BETTER_AUTH_SECRET,
			GITHUB_CLIENT_ID: c.env.GITHUB_CLIENT_ID,
			GITHUB_CLIENT_SECRET: c.env.GITHUB_CLIENT_SECRET,
			GOOGLE_CLIENT_ID: c.env.GOOGLE_CLIENT_ID,
			GOOGLE_CLIENT_SECRET: c.env.GOOGLE_CLIENT_SECRET,
		},
		baseUrl,
	);
	return auth.handler(c.req.raw);
});

// =============================================================================
// Dev-only: E2E test session endpoint
// Creates a test user/org/session in the local D1 for Playwright tests.
// Dead-code-eliminated from production builds by Vite.
// =============================================================================

if (import.meta.env.DEV) {
	app.post('/__test/create-session', async (c) => {
		try {
			const database = drizzle(c.env.DB);
			const userId = 'e2e-test-user';
			const organizationId = 'e2e-test-org';
			const memberId = 'e2e-test-member';
			const sessionId = 'e2e-test-session';
			const sessionToken = 'e2e-test-session-token';
			const now = new Date();
			const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

			await database
				.insert(authSchema.user)
				.values({ id: userId, name: 'E2E Test User', email: 'e2e@test.local', emailVerified: false, createdAt: now, updatedAt: now })
				.onConflictDoNothing();

			await database
				.insert(authSchema.organization)
				.values({ id: organizationId, name: 'E2E Test Org', slug: 'e2e-test-org', plan: 'enterprise', createdAt: now })
				.onConflictDoUpdate({
					target: authSchema.organization.id,
					set: { plan: 'enterprise' },
				});

			await database
				.insert(authSchema.member)
				.values({ id: memberId, organizationId, userId, role: 'owner', createdAt: now })
				.onConflictDoNothing();

			// Purge stale test projects (older than 5 min) so the org limit is never
			// hit from prior runs, without deleting projects that a concurrent
			// Playwright worker may be actively using.
			const staleThreshold = new Date(now.getTime() - 5 * 60 * 1000);
			await database
				.delete(authSchema.project)
				.where(and(eq(authSchema.project.organizationId, organizationId), lte(authSchema.project.createdAt, staleThreshold)));

			// Upsert the session so concurrent Playwright workers don't race on
			// delete-then-insert with the same primary key.
			await database
				.insert(authSchema.session)
				.values({
					id: sessionId,
					token: sessionToken,
					userId,
					expiresAt,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: authSchema.session.id,
					set: { expiresAt, updatedAt: now },
				});

			const { sessionToken: sessionCookie } = getCookies({ baseURL: 'http://localhost' });
			c.header('Set-Cookie', serialize(sessionCookie.name, sessionToken, sessionCookie.attributes));
			return c.json({ userId, organizationId, sessionToken });
		} catch (error) {
			console.error('/__test/create-session failed:', error);
			return c.json({ error: String(error) }, 500);
		}
	});

	app.post('/__test/cleanup', async (c) => {
		try {
			const database = drizzle(c.env.DB);
			const organizationId = 'e2e-test-org';

			await database.delete(authSchema.project).where(eq(authSchema.project.organizationId, organizationId));

			return c.json({ ok: true });
		} catch (error) {
			console.error('/__test/cleanup failed:', error);
			return c.json({ error: String(error) }, 500);
		}
	});
}

// =============================================================================
// Auth middleware — protect all API routes except auth, templates, version
// =============================================================================

app.use('/api/new-project', requireAuth);
app.use('/api/clone-project', requireAuth);
app.use('/api/org/*', requireAuth);
app.use('/api/user/*', requireAuth);
app.use('/api/transfer/*', requireAuth);
app.use('/p/*/api/*', requireAuth);
app.use('/p/*/__agent', requireAuth);
app.use('/p/*/__agent/*', requireAuth);
app.use('/p/*/__ws', requireAuth);
app.use('/p/*/__ws/*', requireAuth);

// =============================================================================
// Org, user, and transfer routes (authed, root-level)
// =============================================================================

app.route('/api', orgRoutes);
app.route('/api', userRoutes);
app.route('/api', transferRoutes);

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

	// Block soft-deleted and banned projects from being previewed (single query)
	const previewDatabase = drizzle(env.DB);
	const previewProjectRow = await previewDatabase
		.select({
			deletedAt: authSchema.project.deletedAt,
			projectBannedAt: authSchema.project.bannedAt,
			orgBannedAt: authSchema.organization.bannedAt,
			previewVisibility: authSchema.project.previewVisibility,
			organizationId: authSchema.project.organizationId,
		})
		.from(authSchema.project)
		.leftJoin(authSchema.organization, eq(authSchema.project.organizationId, authSchema.organization.id))
		.where(eq(authSchema.project.id, projectId))
		.limit(1);

	if (previewProjectRow.length === 0) {
		return errorPage({
			heading: 'Project not found',
			message: "The project you're looking for doesn't exist.",
			homeUrl,
			status: 404,
		});
	}

	if (previewProjectRow[0].deletedAt) {
		return errorPage({
			heading: 'Project deleted',
			message: 'This project has been deleted.',
			homeUrl,
			status: 404,
		});
	}

	if (previewProjectRow[0].projectBannedAt || previewProjectRow[0].orgBannedAt) {
		return errorPage({
			heading: 'Access restricted',
			message: 'Please contact us for assistance.',
			homeUrl,
			status: 403,
		});
	}

	// Enforce preview visibility: private previews require authenticated org membership
	if (previewProjectRow[0].previewVisibility === 'private') {
		const baseUrl = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);
		const auth = createAuth(
			{
				DB: env.DB,
				BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
				GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
				GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
				GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
				GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
			},
			baseUrl,
		);
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) {
			return errorPage({
				heading: 'Private project',
				message: 'Sign in to access this preview.',
				homeUrl,
				status: 403,
			});
		}
		// Check that the authenticated user is a member of the project's org
		const memberRow = await previewDatabase
			.select({ id: authSchema.member.id })
			.from(authSchema.member)
			.where(and(eq(authSchema.member.organizationId, previewProjectRow[0].organizationId), eq(authSchema.member.userId, session.user.id)))
			.limit(1);
		if (memberRow.length === 0) {
			return errorPage({
				heading: 'Private project',
				message: 'You do not have access to this preview.',
				homeUrl,
				status: 403,
			});
		}
	}

	return withMounts(async () => {
		mount(PROJECT_ROOT, fsStub);

		if (url.pathname === '/__ws' || url.pathname.startsWith('/__ws')) {
			const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
			const wsUrl = new URL(request.url);
			wsUrl.pathname = '/ws';
			return coordinatorStub.fetch(new Request(wsUrl, request));
		}

		const previewService = await getPreviewService(PROJECT_ROOT, projectId);
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

	let templateId: string;
	let organizationId: string;
	try {
		const body: { template: string; organizationId: string } = await c.req.json();
		templateId = body.template;
		organizationId = body.organizationId;
	} catch {
		return c.json({ error: 'Request body must contain a template ID and organizationId' }, 400);
	}

	if (!templateId) {
		return c.json({ error: 'Request body must contain a template ID' }, 400);
	}
	if (!organizationId) {
		return c.json({ error: 'Request body must contain an organizationId' }, 400);
	}

	const template = getTemplate(templateId);
	if (!template) {
		return c.json({ error: `Unknown template: ${templateId}` }, 400);
	}

	// Single query: verify membership, get org plan, and check org ban
	const database = drizzle(c.env.DB);
	const orgMemberRow = await database
		.select({
			plan: authSchema.organization.plan,
			orgBannedAt: authSchema.organization.bannedAt,
			memberId: authSchema.member.id,
		})
		.from(authSchema.organization)
		.leftJoin(
			authSchema.member,
			and(eq(authSchema.member.organizationId, authSchema.organization.id), eq(authSchema.member.userId, userId)),
		)
		.where(eq(authSchema.organization.id, organizationId))
		.limit(1);

	if (orgMemberRow.length === 0) {
		return c.json({ error: 'Forbidden' }, 403);
	}

	if (orgMemberRow[0].orgBannedAt) {
		return c.json({ error: 'Forbidden' }, 403);
	}

	if (!orgMemberRow[0].memberId) {
		return c.json({ error: 'You are not a member of this organization.' }, 403);
	}

	// Enforce per-org project limit (plan-based + entitlement overrides)
	const plan = orgMemberRow[0].plan ?? 'free';
	const entitlementRows = await queryEntitlements(database, organizationId);
	const orgLimits = resolveOrgLimitsFromRows(plan, entitlementRows);

	const existingProjects = await database
		.select({ id: authSchema.project.id })
		.from(authSchema.project)
		.where(and(eq(authSchema.project.organizationId, organizationId), isNull(authSchema.project.deletedAt)));
	if (existingProjects.length >= orgLimits.maxProjects) {
		return c.json(
			{ error: `Organization project limit reached (${orgLimits.maxProjects}). Upgrade your plan to create more projects.` },
			400,
		);
	}

	const doId = filesystemNamespace.newUniqueId();
	const projectId = generateProjectId(doId);
	const humanId = generateHumanId();

	await withMounts(async () => {
		const fsStub = filesystemNamespace.get(doId);
		mount(PROJECT_ROOT, fsStub);

		const fs = await import('node:fs/promises');
		await writeTemplateFiles(fs, PROJECT_ROOT, template.files, humanId);
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

	// Look up the authenticated user's name and email for the git commit author
	const userRow = await database
		.select({ name: authSchema.user.name, email: authSchema.user.email })
		.from(authSchema.user)
		.where(eq(authSchema.user.id, userId))
		.limit(1);
	const commitAuthor = {
		name: userRow[0]?.name ?? 'IDE User',
		email: userRow[0]?.email ?? 'user@example.com',
	};

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
						author: commitAuthor,
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

	let sourceProjectId: string;
	let organizationId: string;
	try {
		const body: { sourceProjectId: string; organizationId: string } = await c.req.json();
		sourceProjectId = body.sourceProjectId;
		organizationId = body.organizationId;
	} catch {
		return c.json({ error: 'Request body must contain sourceProjectId and organizationId' }, 400);
	}

	if (!organizationId) {
		return c.json({ error: 'Request body must contain an organizationId' }, 400);
	}

	if (!sourceProjectId || !isValidProjectId(sourceProjectId)) {
		return c.json({ error: 'Invalid source project ID.' }, 400);
	}

	// Single query: verify membership, get org plan, and check org ban
	const cloneDatabase = drizzle(c.env.DB);
	const cloneOrgMemberRow = await cloneDatabase
		.select({
			plan: authSchema.organization.plan,
			orgBannedAt: authSchema.organization.bannedAt,
			memberId: authSchema.member.id,
		})
		.from(authSchema.organization)
		.leftJoin(
			authSchema.member,
			and(eq(authSchema.member.organizationId, authSchema.organization.id), eq(authSchema.member.userId, userId)),
		)
		.where(eq(authSchema.organization.id, organizationId))
		.limit(1);

	if (cloneOrgMemberRow.length === 0) {
		return c.json({ error: 'Forbidden' }, 403);
	}

	if (cloneOrgMemberRow[0].orgBannedAt) {
		return c.json({ error: 'Forbidden' }, 403);
	}

	if (!cloneOrgMemberRow[0].memberId) {
		return c.json({ error: 'You are not a member of this organization.' }, 403);
	}

	let sourceId: DurableObjectId;
	try {
		sourceId = toDurableObjectId(filesystemNamespace, sourceProjectId);
	} catch {
		return c.json({ error: 'Invalid source project ID.' }, 400);
	}

	// Verify the source project is not banned or soft-deleted
	const sourceProjectRow = await cloneDatabase
		.select({
			deletedAt: authSchema.project.deletedAt,
			projectBannedAt: authSchema.project.bannedAt,
			orgBannedAt: authSchema.organization.bannedAt,
		})
		.from(authSchema.project)
		.leftJoin(authSchema.organization, eq(authSchema.project.organizationId, authSchema.organization.id))
		.where(eq(authSchema.project.id, sourceProjectId))
		.limit(1);

	if (
		sourceProjectRow.length > 0 &&
		(sourceProjectRow[0].deletedAt || sourceProjectRow[0].projectBannedAt || sourceProjectRow[0].orgBannedAt)
	) {
		return c.json({ error: 'Forbidden' }, 403);
	}

	const sourceStub = filesystemNamespace.get(sourceId);
	if (!(await sourceStub.projectExists())) {
		return c.json({ error: 'Source project not found or not initialized' }, 404);
	}

	// Enforce per-org project limit (plan-based + entitlement overrides)
	const clonePlan = cloneOrgMemberRow[0].plan ?? 'free';
	const cloneEntitlementRows = await queryEntitlements(cloneDatabase, organizationId);
	const cloneOrgLimits = resolveOrgLimitsFromRows(clonePlan, cloneEntitlementRows);

	const existingCloneProjects = await cloneDatabase
		.select({ id: authSchema.project.id })
		.from(authSchema.project)
		.where(and(eq(authSchema.project.organizationId, organizationId), isNull(authSchema.project.deletedAt)));
	if (existingCloneProjects.length >= cloneOrgLimits.maxProjects) {
		return c.json(
			{ error: `Organization project limit reached (${cloneOrgLimits.maxProjects}). Upgrade your plan to create more projects.` },
			400,
		);
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

	// Look up the authenticated user's name and email for the git commit author
	const cloneUserRow = await database
		.select({ name: authSchema.user.name, email: authSchema.user.email })
		.from(authSchema.user)
		.where(eq(authSchema.user.id, userId))
		.limit(1);
	const cloneCommitAuthor = {
		name: cloneUserRow[0]?.name ?? 'IDE User',
		email: cloneUserRow[0]?.email ?? 'user@example.com',
	};

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
						author: cloneCommitAuthor,
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

	// Single query: soft-delete check, ban check (project + org), and membership
	const userId = c.get('userId');
	if (!userId) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	{
		const database = drizzle(c.env.DB);
		const projectAccessRow = await database
			.select({
				deletedAt: authSchema.project.deletedAt,
				projectBannedAt: authSchema.project.bannedAt,
				orgBannedAt: authSchema.organization.bannedAt,
				memberId: authSchema.member.id,
			})
			.from(authSchema.project)
			.leftJoin(authSchema.organization, eq(authSchema.project.organizationId, authSchema.organization.id))
			.leftJoin(
				authSchema.member,
				and(eq(authSchema.member.organizationId, authSchema.project.organizationId), eq(authSchema.member.userId, userId)),
			)
			.where(eq(authSchema.project.id, projectId))
			.limit(1);

		if (projectAccessRow.length === 0 || projectAccessRow[0].deletedAt) {
			return c.notFound();
		}

		if (projectAccessRow[0].projectBannedAt || projectAccessRow[0].orgBannedAt) {
			return c.json({ error: 'Forbidden' }, 403);
		}

		if (!projectAccessRow[0].memberId) {
			return c.json({ error: 'Forbidden' }, 403);
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
		const agentStub = agentRunnerNamespace.getByName(`agent:${projectId}`);
		const agentUrl = new URL(c.req.url);
		agentUrl.pathname = '/';
		const agentHeaders = new Headers(c.req.raw.headers);
		agentHeaders.set('x-partykit-room', `agent:${projectId}`);
		agentHeaders.set('x-worker-ide-user-id', userId);
		return agentStub.fetch(new Request(agentUrl, { ...c.req.raw, headers: agentHeaders }));
	}

	return withMounts(async () => {
		mount(PROJECT_ROOT, fsStub);

		if (subPath === '/__ws' || subPath.startsWith('/__ws')) {
			const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
			const wsUrl = new URL(c.req.url);
			wsUrl.pathname = '/ws';
			return coordinatorStub.fetch(new Request(wsUrl, c.req.raw));
		}

		const projectApp = new Hono<AppEnvironment>();

		projectApp.use('*', async (context, innerNext) => {
			context.set('userId', c.get('userId'));
			context.set('userSession', c.get('userSession'));
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
				/^\/p\/[^/]+\/__agent(\/|$)/.test(url.pathname) ||
				/^\/p\/[^/]+\/api\/stt\/ws$/.test(url.pathname);

			if (!isValidWebSocketPath) {
				return new Response('WebSocket not supported on this path', { status: 404 });
			}
		}

		const parsed = parseHost(url.host);

		switch (parsed.type) {
			case 'preview': {
				const secret = import.meta.env.DEV ? env.PREVIEW_SECRET || DEV_PREVIEW_SECRET : env.PREVIEW_SECRET;
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

			case 'git': {
				// Proxy Git Smart HTTP v2 requests to the git auxiliary worker.
				// JWT verification is handled by the git worker itself.
				return environment.GIT_WORKER.fetch(request);
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
						const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
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

const CLONE_SKIP_ENTRIES = new Set(['.initialized', '.agent', '.git']);

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
