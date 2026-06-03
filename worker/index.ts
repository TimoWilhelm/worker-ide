import { getCookies } from 'better-auth/cookies';
import { env } from 'cloudflare:workers';
import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serialize, serializeSigned } from 'hono/utils/cookie';
import { mount, withMounts } from 'worker-fs-mount';
import { z } from 'zod';

import { PROJECT_INACTIVITY_DAYS, SOFT_DELETE_RETENTION_DAYS } from '@shared/constants';
import { buildAppOrigin, parseHost } from '@shared/domain';
import { ENTITLEMENT_ORG_MAX_PROJECTS, ENTITLEMENT_USER_MAX_FREE_ORGS } from '@shared/entitlements';
import { generateHumanId } from '@shared/human-id';
import { EFFECTIVE_LIMIT_ORG_MAX_PROJECTS } from '@shared/limits';
import { validatePreviewToken } from '@shared/preview-token';
import { isValidProjectId } from '@shared/project-id';

import * as authSchema from './db/auth-schema';
import { trackPreviewRequest, trackProjectEvent } from './lib/analytics';
import { analyticsMiddleware } from './lib/analytics-middleware';
import { createAuth } from './lib/auth';
import { requireAuth } from './lib/auth-middleware';
import { agentRunnerNamespace, coordinatorNamespace, filesystemNamespace } from './lib/durable-object-namespaces';
import { errorPage, previewExpiredPage } from './lib/error-page';
import { getEffectiveLimit } from './lib/limits';
import {
	buildPreviewAccessBootstrapUrl,
	buildPreviewAccessLoginUrl,
	buildPreviewRedeemUrl,
	clearPreviewAccessCookie,
	createPreviewAccessCookieToken,
	createPreviewAccessGrant,
	getRedirectPath,
	isNavigationRequest,
	PREVIEW_ACCESS_REDEEM_PATH,
	readPreviewAccessCookie,
	readPreviewAccessGrant,
	serializePreviewAccessCookie,
} from './lib/preview-access';
import { DEV_PREVIEW_SECRET } from './lib/preview-secret';
import { generateProjectId, toDurableObjectId } from './lib/project-id';
import { requireRateLimit } from './lib/rate-limit-middleware';
import { apiRoutes } from './routes';
import { developmentTestRoutes } from './routes/development-test-routes';
import { orgRoutes } from './routes/org-routes';
import { transferRoutes } from './routes/transfer-routes';
import { userRoutes } from './routes/user-routes';
import { GitClient } from './services/git-client';
import { collectChanges } from './services/working-tree';
import { getTemplate, getTemplateMetadata } from './templates';

import type { PreviewService } from './services/preview-service';
import type { AppEnvironment, AuthedEnvironment } from './types';
import type { CommitFileEntry } from '@shared/git-types';
import type { MiddlewareHandler } from 'hono';

// Cache PreviewService instances at module scope. The service is stateless, so
// reusing it only avoids repeated dynamic imports on hot paths.

const MAX_PREVIEW_SERVICE_CACHE_SIZE = 100;
const previewServiceCache = new Map<string, PreviewService>();
const PREVIEW_ROBOTS_HEADER_VALUE = 'noindex, nofollow';

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
export { AgentRunner, DurableObjectFilesystem, ProjectCoordinatorV2, ProjectMetadata, SubAgentWorker } from './durable';
export { LogTailer } from './services/log-tailer';
export { ObjectStorageBinding } from './services/object-storage-binding';
export { DeployWorkflow } from './workflows/deploy-workflow';

const PROJECT_ROOT = '/project';
const AUTHENTICATED_API_ROUTE_PATTERNS = ['/api/*', '/p/*/api/*'];
const AUTHENTICATED_NON_API_ROUTE_PATTERNS = ['/p/*/__agent', '/p/*/__agent/*', '/p/*/__ws', '/p/*/__ws/*'];
const PROJECT_DELETED_VIA_PROJECT = 'project';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type ResponseMiddleware = (request: Request, next: () => Promise<Response>) => Promise<Response>;

function registerMiddleware(
	appInstance: Hono<AuthedEnvironment>,
	routePatterns: string[],
	middleware: MiddlewareHandler<AuthedEnvironment>,
) {
	for (const routePattern of routePatterns) {
		appInstance.use(routePattern, middleware);
	}
}

function registerProtectedApiMiddleware(appInstance: Hono<AuthedEnvironment>, middleware: MiddlewareHandler<AuthedEnvironment>) {
	registerMiddleware(appInstance, AUTHENTICATED_API_ROUTE_PATTERNS, middleware);
}

async function destroyProjectStorage(durableObjectHexId: string): Promise<void> {
	const filesystemId = filesystemNamespace.idFromString(durableObjectHexId);
	const filesystemStub = filesystemNamespace.get(filesystemId);
	await filesystemStub.destroyStorage();
}

async function deleteProjectRowsByIds(database: ReturnType<typeof drizzle>, projectIds: string[]): Promise<void> {
	if (projectIds.length === 0) {
		return;
	}

	await database.batch([
		database.delete(authSchema.userProjectAccess).where(inArray(authSchema.userProjectAccess.projectId, projectIds)),
		database.delete(authSchema.userProjectFavorite).where(inArray(authSchema.userProjectFavorite.projectId, projectIds)),
		database.delete(authSchema.projectTransfer).where(inArray(authSchema.projectTransfer.projectId, projectIds)),
		database.delete(authSchema.project).where(inArray(authSchema.project.id, projectIds)),
	]);
}

async function hardDeleteProjectById(
	database: ReturnType<typeof drizzle>,
	project: { id: string; durableObjectHexId: string },
): Promise<boolean> {
	try {
		await destroyProjectStorage(project.durableObjectHexId);
	} catch (error) {
		console.warn(`Failed to delete DO for project ${project.id}:`, error);
		return false;
	}

	await deleteProjectRowsByIds(database, [project.id]);

	return true;
}

async function hardDeleteOrganizationById(database: ReturnType<typeof drizzle>, organizationId: string): Promise<boolean> {
	const projectRows = await database
		.select({ id: authSchema.project.id, durableObjectHexId: authSchema.project.durableObjectHexId })
		.from(authSchema.project)
		.where(eq(authSchema.project.organizationId, organizationId));

	for (const project of projectRows) {
		try {
			await destroyProjectStorage(project.durableObjectHexId);
		} catch (error) {
			console.warn(`Failed to delete DO for project ${project.id}:`, error);
			return false;
		}
	}

	await deleteProjectRowsByIds(
		database,
		projectRows.map((project) => project.id),
	);

	await database.batch([
		database
			.delete(authSchema.projectTransfer)
			.where(
				or(
					eq(authSchema.projectTransfer.sourceOrganizationId, organizationId),
					eq(authSchema.projectTransfer.targetOrganizationId, organizationId),
				),
			),
		database.delete(authSchema.billingEvent).where(eq(authSchema.billingEvent.organizationId, organizationId)),
		database.delete(authSchema.entitlement).where(eq(authSchema.entitlement.scopeId, organizationId)),
		database
			.update(authSchema.session)
			// eslint-disable-next-line unicorn/no-null -- D1 requires null to clear nullable columns
			.set({ activeOrganizationId: null, updatedAt: new Date() })
			.where(eq(authSchema.session.activeOrganizationId, organizationId)),
		database.delete(authSchema.organization).where(eq(authSchema.organization.id, organizationId)),
	]);

	return true;
}

function buildSeedFiles(files: Record<string, string>, projectName: string): Array<{ path: string; content: string }> {
	const seedFiles: Array<{ path: string; content: string }> = [];

	for (const [filePath, content] of Object.entries(files)) {
		if (filePath === 'package.json') {
			const packageJson: Record<string, unknown> = JSON.parse(content);
			packageJson.name = projectName;
			seedFiles.push({ path: '/package.json', content: JSON.stringify(packageJson, undefined, '\t') + '\n' });
		} else {
			seedFiles.push({ path: `/${filePath}`, content });
		}
	}

	seedFiles.push({ path: '/.initialized', content: '1' });

	return seedFiles;
}

async function resolveSessionFromRequest(
	request: Request,
	environment: Pick<
		Env,
		'DB' | 'BETTER_AUTH_SECRET' | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'
	>,
	baseUrl: string,
): Promise<{ sessionId: string; userId: string } | undefined> {
	if (import.meta.env.DEV) {
		const { resolveDevelopmentSession } = await import('./lib/development-session');
		const result = await resolveDevelopmentSession(environment.DB, request.headers);
		if (!result) {
			return undefined;
		}
		return { sessionId: result.session.id, userId: result.session.userId };
	}

	const auth = createAuth(environment, baseUrl);
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) {
		return undefined;
	}

	return {
		sessionId: session.session.id,
		userId: session.user.id,
	};
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

function withUpdatedHeaders(response: Response, headers: Record<string, string>): Response {
	if (response.status === 101) {
		return response;
	}

	const nextHeaders = new Headers(response.headers);
	for (const [name, value] of Object.entries(headers)) {
		nextHeaders.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: nextHeaders,
	});
}

function applyAppSecurityHeaders(response: Response): Response {
	return withUpdatedHeaders(response, {
		'Content-Security-Policy': "frame-ancestors 'self'",
		'X-Frame-Options': 'SAMEORIGIN',
	});
}

function applyPreviewRobotsHeader(response: Response): Response {
	return withUpdatedHeaders(response, {
		'X-Robots-Tag': PREVIEW_ROBOTS_HEADER_VALUE,
	});
}

async function appSecurityHeadersMiddleware(_request: Request, next: () => Promise<Response>): Promise<Response> {
	return applyAppSecurityHeaders(await next());
}

async function previewRobotsHeadersMiddleware(_request: Request, next: () => Promise<Response>): Promise<Response> {
	return applyPreviewRobotsHeader(await next());
}

function composeResponseMiddleware(
	request: Request,
	handler: () => Promise<Response>,
	middlewares: ResponseMiddleware[],
): Promise<Response> {
	let next = handler;
	for (const middleware of middlewares.toReversed()) {
		const currentNext = next;
		next = () => middleware(request, currentNext);
	}
	return next();
}

function hasValidWebSocketOrigin(request: Request, expectedOrigin: string): boolean {
	return request.headers.get('Origin') === expectedOrigin;
}

function hasValidAppRequestOrigin(request: Request, expectedOrigin: string): boolean {
	const origin = request.headers.get('Origin');
	if (origin) {
		return origin === expectedOrigin;
	}

	const referer = request.headers.get('Referer');
	if (!referer) {
		return true;
	}

	try {
		return new URL(referer).origin === expectedOrigin;
	} catch {
		return false;
	}
}

const requireSameOriginUnsafeMethods: MiddlewareHandler<AuthedEnvironment> = async (c, next) => {
	if (!UNSAFE_METHODS.has(c.req.method)) {
		await next();
		return;
	}

	const requestUrl = new URL(c.req.url);
	const appOrigin = buildAppOrigin(parseHost(requestUrl.host).baseDomain, requestUrl.protocol);
	if (!hasValidAppRequestOrigin(c.req.raw, appOrigin)) {
		return c.json({ error: 'Forbidden' }, 403);
	}

	await next();
};

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

registerProtectedApiMiddleware(app, requireSameOriginUnsafeMethods);

app.get('/api/health', (c) => c.json({ ok: true }));

// In dev mode, better-auth's internal loopback HTTP calls crash inside
// miniflare, so resolve the session endpoint directly from D1 instead.

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

		const database = drizzle(c.env.DB, { schema: authSchema });
		const memberships = await database
			.select({ organizationId: authSchema.member.organizationId })
			.from(authSchema.member)
			.where(eq(authSchema.member.userId, result.user.id));

		const organizationIds = memberships.map((m) => m.organizationId);
		if (organizationIds.length === 0) return c.json([]);

		const organizations = await database
			.select()
			.from(authSchema.organization)
			.where(and(inArray(authSchema.organization.id, organizationIds), isNull(authSchema.organization.deletedAt)));
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
		const database = drizzle(c.env.DB, { schema: authSchema });

		const membership = await database
			.select({ id: authSchema.member.id })
			.from(authSchema.member)
			.innerJoin(authSchema.organization, eq(authSchema.organization.id, authSchema.member.organizationId))
			.where(
				and(
					eq(authSchema.member.organizationId, body.organizationId),
					eq(authSchema.member.userId, result.user.id),
					isNull(authSchema.organization.deletedAt),
				),
			)
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
const exchangeCodeSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[\w-]+$/);

app.get('/api/auth/session/exchange', async (c) => {
	const codeResult = exchangeCodeSchema.safeParse(c.req.query('code'));
	if (!codeResult.success) return c.redirect('/');

	const code = codeResult.data;
	const database = drizzle(c.env.DB, { schema: authSchema });
	const now = new Date();
	const identifier = `session-exchange:${code}`;
	const [row] = await database
		.delete(authSchema.verification)
		.where(and(eq(authSchema.verification.identifier, identifier), gt(authSchema.verification.expiresAt, now)))
		.returning({ value: authSchema.verification.value });

	if (!row) return c.redirect('/');

	const url = new URL(c.req.url);
	const baseUrl = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);
	const { sessionToken, sessionData, dontRememberToken } = getCookies({ baseURL: baseUrl, secret: c.env.BETTER_AUTH_SECRET });

	const setSessionCookie = await serializeSigned(sessionToken.name, row.value, c.env.BETTER_AUTH_SECRET, sessionToken.attributes);
	const expireDataCookie = serialize(sessionData.name, '', { ...sessionData.attributes, maxAge: 0 });

	const setDontRememberCookie = await serializeSigned(
		dontRememberToken.name,
		'true',
		c.env.BETTER_AUTH_SECRET,
		dontRememberToken.attributes,
	);

	const headers = new Headers();
	headers.set('Location', '/');
	headers.append('Set-Cookie', setSessionCookie);
	headers.append('Set-Cookie', expireDataCookie);
	headers.append('Set-Cookie', setDontRememberCookie);

	return new Response(undefined, { status: 302, headers });
});

// Disable better-auth admin plugin HTTP endpoints
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
		c.req.raw,
	);
	return auth.handler(c.req.raw);
});

app.use('/p/:projectId/__preview-auth/*', async (c, next) => {
	await next();
	c.res = applyPreviewRobotsHeader(c.res);
});

app.get('/p/:projectId/__preview-auth/bootstrap', async (c) => {
	const { projectId } = c.req.param();
	if (!isValidProjectId(projectId)) {
		return c.notFound();
	}

	const currentUrl = new URL(c.req.url);
	const appOrigin = buildAppOrigin(parseHost(currentUrl.host).baseDomain, currentUrl.protocol);
	const returnTo = c.req.query('returnTo');
	if (!returnTo) {
		return errorPage({
			heading: 'Invalid preview link',
			message: 'This preview link is missing its return target.',
			homeUrl: `${appOrigin}/`,
			status: 400,
		});
	}

	let returnToUrl: URL;
	try {
		returnToUrl = new URL(returnTo);
	} catch {
		return errorPage({
			heading: 'Invalid preview link',
			message: 'This preview link could not be validated.',
			homeUrl: `${appOrigin}/`,
			status: 400,
		});
	}

	const parsedReturnHost = parseHost(returnToUrl.host);
	if (
		parsedReturnHost.type !== 'preview' ||
		parsedReturnHost.projectId !== projectId ||
		parsedReturnHost.baseDomain !== parseHost(currentUrl.host).baseDomain
	) {
		return errorPage({
			heading: 'Invalid preview link',
			message: 'This preview link does not belong to this project.',
			homeUrl: `${appOrigin}/`,
			status: 400,
		});
	}

	const secret = import.meta.env.DEV ? c.env.PREVIEW_SECRET || DEV_PREVIEW_SECRET : c.env.PREVIEW_SECRET;
	const isValidToken = await validatePreviewToken(parsedReturnHost.projectId, parsedReturnHost.token, secret);
	if (!isValidToken) {
		return errorPage({
			heading: 'Preview link expired',
			message: 'This preview link is no longer valid. Open the editor to get a fresh preview link.',
			homeUrl: `${appOrigin}/`,
			status: 403,
		});
	}

	const database = drizzle(c.env.DB, { schema: authSchema });
	const previewProjectRow = await database
		.select({
			deletedAt: authSchema.project.deletedAt,
			projectBannedAt: authSchema.project.bannedAt,
			orgDeletedAt: authSchema.organization.deletedAt,
			orgBannedAt: authSchema.organization.bannedAt,
			previewVisibility: authSchema.project.previewVisibility,
			organizationId: authSchema.project.organizationId,
		})
		.from(authSchema.project)
		.leftJoin(authSchema.organization, eq(authSchema.project.organizationId, authSchema.organization.id))
		.where(eq(authSchema.project.id, projectId))
		.limit(1);

	if (previewProjectRow.length === 0 || previewProjectRow[0].deletedAt || previewProjectRow[0].orgDeletedAt) {
		return errorPage({
			heading: 'Project not found',
			message: "The project you're looking for doesn't exist or has expired.",
			homeUrl: `${appOrigin}/`,
			status: 404,
		});
	}

	if (previewProjectRow[0].projectBannedAt || previewProjectRow[0].orgBannedAt) {
		return errorPage({
			heading: 'Access restricted',
			message: 'Please contact us for assistance.',
			homeUrl: `${appOrigin}/`,
			status: 403,
		});
	}

	if ((previewProjectRow[0].previewVisibility ?? 'public') !== 'private') {
		return Response.redirect(returnToUrl.toString(), 302);
	}

	const session = await resolveSessionFromRequest(c.req.raw, c.env, appOrigin);
	if (!session) {
		return Response.redirect(buildPreviewAccessLoginUrl(appOrigin, currentUrl.toString()), 302);
	}

	const memberRow = await database
		.select({ id: authSchema.member.id })
		.from(authSchema.member)
		.where(and(eq(authSchema.member.organizationId, previewProjectRow[0].organizationId), eq(authSchema.member.userId, session.userId)))
		.limit(1);
	if (memberRow.length === 0) {
		return errorPage({
			heading: 'Private project',
			message: 'You do not have access to this preview.',
			homeUrl: `${appOrigin}/`,
			status: 403,
		});
	}

	const grant = await createPreviewAccessGrant(
		{
			projectId,
			previewToken: parsedReturnHost.token,
			organizationId: previewProjectRow[0].organizationId,
			userId: session.userId,
			redirectPath: getRedirectPath(returnToUrl),
		},
		secret,
	);

	return Response.redirect(buildPreviewRedeemUrl(returnToUrl.origin, grant), 302);
});

app.get('/api/templates', (c) => {
	return c.json({ templates: getTemplateMetadata() });
});

app.get('/api/version', (c) => {
	const metadata = env.CF_VERSION_METADATA;
	return c.json({
		id: metadata.id,
		timestamp: metadata.timestamp,
		tag: metadata.tag,
	});
});

// Dev-only E2E helper for seeding a local test user, org, and session.

if (import.meta.env.DEV) {
	app.post('/__test/create-session', async (c) => {
		try {
			const database = drizzle(c.env.DB, { schema: authSchema });
			const userId = 'e2e-test-user';
			const organizationId = '11111111-1111-4111-8111-111111111111';
			const organizationSlug = '22222222-2222-4222-8222-222222222222';
			const memberId = 'e2e-test-member';
			const sessionId = 'e2e-test-session';
			const sessionToken = 'e2e-test-session-token';
			const now = new Date();
			const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

			await database
				.insert(authSchema.user)
				.values({
					id: userId,
					name: 'E2E Test User',
					email: 'e2e@test.local',
					emailVerified: false,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: authSchema.user.id,
					set: { updatedAt: now },
				});

			await database
				.insert(authSchema.organization)
				.values({ id: organizationId, name: 'E2E Test Org', slug: organizationSlug, plan: 'free', createdAt: now })
				.onConflictDoUpdate({
					target: authSchema.organization.id,
					set: { plan: 'free', slug: organizationSlug },
				});

			await database
				.insert(authSchema.member)
				.values({ id: memberId, organizationId, userId, role: 'owner', createdAt: now })
				.onConflictDoUpdate({
					target: authSchema.member.id,
					set: { organizationId, userId, role: 'owner', createdAt: now },
				});

			await database
				.insert(authSchema.entitlement)
				.values({
					id: 'e2e-test-max-free-orgs',
					scopeId: userId,
					key: ENTITLEMENT_USER_MAX_FREE_ORGS,
					valueType: 'number',
					value: '100',
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: authSchema.entitlement.id,
					set: {
						scopeId: userId,
						key: ENTITLEMENT_USER_MAX_FREE_ORGS,
						valueType: 'number',
						value: '100',
						updatedAt: now,
					},
				});

			await database
				.insert(authSchema.entitlement)
				.values({
					id: 'e2e-test-org-max-projects',
					scopeId: organizationId,
					key: ENTITLEMENT_ORG_MAX_PROJECTS,
					valueType: 'number',
					value: '100',
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: authSchema.entitlement.id,
					set: {
						scopeId: organizationId,
						key: ENTITLEMENT_ORG_MAX_PROJECTS,
						valueType: 'number',
						value: '100',
						updatedAt: now,
					},
				});

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
			const database = drizzle(c.env.DB, { schema: authSchema });
			const organizationId = '11111111-1111-4111-8111-111111111111';

			await database.delete(authSchema.project).where(eq(authSchema.project.organizationId, organizationId));

			return c.json({ ok: true });
		} catch (error) {
			console.error('/__test/cleanup failed:', error);
			return c.json({ error: String(error) }, 500);
		}
	});
}

registerProtectedApiMiddleware(app, requireAuth);
registerMiddleware(app, AUTHENTICATED_NON_API_ROUTE_PATTERNS, requireAuth);

// Register analytics after auth so rejected requests are never recorded.

registerProtectedApiMiddleware(app, analyticsMiddleware);

registerProtectedApiMiddleware(app, requireRateLimit);

app.route('/api', orgRoutes);
app.route('/api', userRoutes);
app.route('/api', transferRoutes);

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
async function handlePreviewRequest(request: Request, projectId: string, previewToken: string): Promise<Response> {
	const previewStart = Date.now();
	const url = new URL(request.url);

	if (isDevelopmentInfrastructurePath(url.pathname)) {
		return env.ASSETS.fetch(request);
	}
	function trackAndReturn(response: Response, visibility = ''): Response {
		trackPreviewRequest({
			projectId,
			pathname: url.pathname,
			contentType: response.headers.get('Content-Type') ?? '',
			visibility,
			statusCode: response.status,
			durationMs: Date.now() - previewStart,
			responseSize: Number(response.headers.get('Content-Length') ?? 0),
			request,
		});
		return response;
	}

	const appOrigin = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);

	const homeUrl = `${appOrigin}/`;

	let fsId: DurableObjectId;
	try {
		fsId = toDurableObjectId(filesystemNamespace, projectId);
	} catch {
		return trackAndReturn(
			errorPage({
				heading: 'Invalid project',
				message: 'The project ID in this URL is not valid.',
				homeUrl,
				status: 400,
			}),
		);
	}

	const fsStub = filesystemNamespace.get(fsId);
	if (!(await fsStub.projectExists())) {
		return trackAndReturn(
			errorPage({
				heading: 'Project not found',
				message: "The project you're looking for doesn't exist or has expired.",
				homeUrl,
				status: 404,
			}),
		);
	}

	// Block soft-deleted and banned projects from being previewed (single query)
	const previewDatabase = drizzle(env.DB, { schema: authSchema });
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
		return trackAndReturn(
			errorPage({
				heading: 'Project not found',
				message: "The project you're looking for doesn't exist.",
				homeUrl,
				status: 404,
			}),
		);
	}

	if (previewProjectRow[0].deletedAt) {
		return trackAndReturn(
			errorPage({
				heading: 'Project deleted',
				message: 'This project has been deleted.',
				homeUrl,
				status: 404,
			}),
		);
	}

	if (previewProjectRow[0].projectBannedAt || previewProjectRow[0].orgBannedAt) {
		return trackAndReturn(
			errorPage({
				heading: 'Access restricted',
				message: 'Please contact us for assistance.',
				homeUrl,
				status: 403,
			}),
		);
	}

	const previewVisibility = previewProjectRow[0].previewVisibility ?? 'public';
	const previewSecret = import.meta.env.DEV ? env.PREVIEW_SECRET || DEV_PREVIEW_SECRET : env.PREVIEW_SECRET;

	if (url.pathname === PREVIEW_ACCESS_REDEEM_PATH) {
		const grantToken = url.searchParams.get('grant');
		const grantPayload = grantToken ? await readPreviewAccessGrant(grantToken, previewSecret) : undefined;
		if (!grantPayload || grantPayload.projectId !== projectId || grantPayload.previewToken !== previewToken) {
			return trackAndReturn(
				errorPage({
					heading: 'Preview access expired',
					message: 'This preview access link is no longer valid. Open the editor to get a fresh preview link.',
					homeUrl,
					status: 403,
				}),
				previewVisibility,
			);
		}

		const cookieToken = await createPreviewAccessCookieToken(
			{
				projectId,
				previewToken,
				organizationId: grantPayload.organizationId,
				userId: grantPayload.userId,
			},
			previewSecret,
		);
		const headers = new Headers();
		headers.set('Location', new URL(grantPayload.redirectPath, url.origin).toString());
		for (const cookie of serializePreviewAccessCookie(cookieToken, url)) {
			headers.append('Set-Cookie', cookie);
		}
		return trackAndReturn(new Response(undefined, { status: 302, headers }), previewVisibility);
	}

	// Enforce preview visibility with a preview-only host cookie. The preview host
	// never receives app session cookies; it only sees its own scoped access grant.
	if (previewProjectRow[0].previewVisibility === 'private') {
		const previewAccess = await readPreviewAccessCookie(request.headers, previewSecret, projectId, previewToken, url);
		if (!previewAccess) {
			if (isNavigationRequest(request)) {
				return trackAndReturn(
					Response.redirect(buildPreviewAccessBootstrapUrl(appOrigin, projectId, url.toString()), 302),
					previewVisibility,
				);
			}

			return trackAndReturn(
				new Response('Forbidden', {
					status: 403,
					headers: (() => {
						const headers = new Headers({ 'Cache-Control': 'no-cache' });
						for (const cookie of clearPreviewAccessCookie(url)) {
							headers.append('Set-Cookie', cookie);
						}
						return headers;
					})(),
				}),
				previewVisibility,
			);
		}
	}

	const response = await withMounts(async () => {
		mount(PROJECT_ROOT, fsStub);

		if (url.pathname === '/__ws' || url.pathname.startsWith('/__ws')) {
			if (!hasValidWebSocketOrigin(request, url.origin)) {
				return new Response('Forbidden', { status: 403 });
			}
			const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
			const wsUrl = new URL(request.url);
			wsUrl.pathname = '/ws';
			const wsRequest = new Request(wsUrl, request);
			wsRequest.headers.set('x-project-id', projectId);
			wsRequest.headers.set('x-worker-ide-client-kind', 'preview');
			return coordinatorStub.fetch(wsRequest);
		}

		const previewService = await getPreviewService(PROJECT_ROOT, projectId);
		const assetSettings = await previewService.loadAssetSettings();

		return previewService.routePreviewRequest(request, appOrigin, assetSettings);
	});

	return trackAndReturn(response, previewVisibility);
}

app.post('/api/new-project', async (c) => {
	const projectCreateStart = Date.now();
	const { userId } = c.get('session');

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
	const database = drizzle(c.env.DB, { schema: authSchema });
	const orgMemberRow = await database
		.select({
			plan: authSchema.organization.plan,
			orgDeletedAt: authSchema.organization.deletedAt,
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

	if (orgMemberRow[0].orgDeletedAt) {
		return c.json({ error: 'Organization not found.' }, 404);
	}

	if (orgMemberRow[0].orgBannedAt) {
		return c.json({ error: 'Forbidden' }, 403);
	}

	if (!orgMemberRow[0].memberId) {
		return c.json({ error: 'You are not a member of this organization.' }, 403);
	}

	// Enforce per-org project limit (plan-based + entitlement overrides)
	const orgMaxProjects = await getEffectiveLimit(database, {
		key: EFFECTIVE_LIMIT_ORG_MAX_PROJECTS,
		organizationId,
		plan: orgMemberRow[0].plan ?? 'free',
	});
	const existingProjects = await database
		.select({ id: authSchema.project.id })
		.from(authSchema.project)
		.where(and(eq(authSchema.project.organizationId, organizationId), isNull(authSchema.project.deletedAt)));
	if (existingProjects.length >= orgMaxProjects) {
		return c.json({ error: `Organization project limit reached (${orgMaxProjects}). Upgrade your plan to create more projects.` }, 400);
	}

	const doId = filesystemNamespace.newUniqueId();
	const projectId = generateProjectId(doId);
	const projectName = generateHumanId();

	try {
		const seedStub = filesystemNamespace.get(doId);
		await seedStub.writeFiles(buildSeedFiles(template.files, projectName));

		// Register project in D1
		const now = new Date();
		await database.insert(authSchema.project).values({
			id: projectId,
			organizationId,
			durableObjectHexId: doId.toString(),
			name: projectName,
			previewVisibility: 'public',
			createdAt: now,
			updatedAt: now,
			lastActivityAt: now,
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

		trackProjectEvent({
			organizationId,
			eventType: 'create',
			projectId,
			userId,
			detail: templateId,
			plan: orgMemberRow[0].plan ?? 'free',
			durationMs: Date.now() - projectCreateStart,
			success: true,
			request: c.req.raw,
		});

		return c.json({ projectId, url: `/p/${projectId}`, name: projectName });
	} catch (error) {
		console.error('Failed to create project:', error);
		trackProjectEvent({
			organizationId,
			eventType: 'create',
			projectId,
			userId,
			detail: templateId,
			plan: orgMemberRow[0].plan ?? 'free',
			error: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - projectCreateStart,
			success: false,
			request: c.req.raw,
		});
		throw error;
	}
});

app.post('/api/clone-project', async (c) => {
	const cloneStart = Date.now();
	const { userId } = c.get('session');

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
	const cloneDatabase = drizzle(c.env.DB, { schema: authSchema });
	const cloneOrgMemberRow = await cloneDatabase
		.select({
			plan: authSchema.organization.plan,
			orgDeletedAt: authSchema.organization.deletedAt,
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

	if (cloneOrgMemberRow[0].orgDeletedAt) {
		return c.json({ error: 'Organization not found.' }, 404);
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

	if (sourceProjectRow.length === 0) {
		return c.json({ error: 'Source project not found.' }, 404);
	}

	if (sourceProjectRow[0].deletedAt || sourceProjectRow[0].projectBannedAt || sourceProjectRow[0].orgBannedAt) {
		return c.json({ error: 'Forbidden' }, 403);
	}

	const sourceStub = filesystemNamespace.get(sourceId);
	if (!(await sourceStub.projectExists())) {
		return c.json({ error: 'Source project not found or not initialized' }, 404);
	}

	// Enforce per-org project limit (plan-based + entitlement overrides)
	const cloneOrgMaxProjects = await getEffectiveLimit(cloneDatabase, {
		key: EFFECTIVE_LIMIT_ORG_MAX_PROJECTS,
		organizationId,
		plan: cloneOrgMemberRow[0].plan ?? 'free',
	});
	const existingCloneProjects = await cloneDatabase
		.select({ id: authSchema.project.id })
		.from(authSchema.project)
		.where(and(eq(authSchema.project.organizationId, organizationId), isNull(authSchema.project.deletedAt)));
	if (existingCloneProjects.length >= cloneOrgMaxProjects) {
		return c.json({ error: `Organization project limit reached (${cloneOrgMaxProjects}).` }, 400);
	}

	const newDoId = filesystemNamespace.newUniqueId();
	const newProjectId = generateProjectId(newDoId);
	const projectName = generateHumanId();

	try {
		await withMounts(async () => {
			const destinationStub = filesystemNamespace.get(newDoId);
			mount('/source', sourceStub);
			mount('/destination', destinationStub);

			const fs = await import('node:fs/promises');

			await copyDirectoryRecursive(fs, '/source', '/destination');
			await fs.writeFile('/destination/.initialized', '1');
		});

		// Register cloned project in D1
		const database = drizzle(c.env.DB, { schema: authSchema });
		const now = new Date();
		await database.insert(authSchema.project).values({
			id: newProjectId,
			organizationId,
			durableObjectHexId: newDoId.toString(),
			name: projectName,
			previewVisibility: 'public',
			createdAt: now,
			updatedAt: now,
			lastActivityAt: now,
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

		trackProjectEvent({
			organizationId,
			eventType: 'clone',
			projectId: newProjectId,
			userId,
			detail: sourceProjectId,
			plan: cloneOrgMemberRow[0].plan ?? 'free',
			durationMs: Date.now() - cloneStart,
			success: true,
			request: c.req.raw,
		});

		return c.json({ projectId: newProjectId, url: `/p/${newProjectId}`, name: projectName });
	} catch (error) {
		console.error('Failed to clone project:', error);
		trackProjectEvent({
			organizationId,
			eventType: 'clone',
			projectId: newProjectId,
			userId,
			detail: sourceProjectId,
			plan: cloneOrgMemberRow[0].plan ?? 'free',
			error: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - cloneStart,
			success: false,
			request: c.req.raw,
		});
		throw error;
	}
});

// Project-scoped API / WebSocket / preview routes
app.all('/p/:projectId/*', async (c) => {
	const path = new URL(c.req.url).pathname;
	const projectRoute = parseProjectRoute(path);

	if (!projectRoute) {
		return env.ASSETS.fetch(c.req.raw);
	}

	const { projectId, subPath } = projectRoute;
	const requestUrl = new URL(c.req.url);
	const appOrigin = buildAppOrigin(parseHost(requestUrl.host).baseDomain, requestUrl.protocol);

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
	const { userId } = c.get('session');
	if (!userId) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	{
		const database = drizzle(c.env.DB, { schema: authSchema });
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

	// Fire-and-forget: bump project last-activity + per-user access tracking.
	const session = c.get('session');
	if (session.updateActivity) {
		c.executionCtx.waitUntil(
			(async () => {
				try {
					const database = drizzle(c.env.DB, { schema: authSchema });
					const now = new Date();
					await database.batch([
						database
							.insert(authSchema.userProjectAccess)
							.values({
								id: crypto.randomUUID(),
								userId,
								projectId,
								lastAccessedAt: now,
							})
							.onConflictDoUpdate({
								target: [authSchema.userProjectAccess.userId, authSchema.userProjectAccess.projectId],
								set: { lastAccessedAt: now },
							}),
						database.update(authSchema.project).set({ lastActivityAt: now }).where(eq(authSchema.project.id, projectId)),
					]);
				} catch (error) {
					console.error('Failed to record project access:', error);
				}
			})(),
		);
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
		if ((c.req.raw.headers.has('Origin') || UNSAFE_METHODS.has(c.req.method)) && !hasValidAppRequestOrigin(c.req.raw, appOrigin)) {
			return new Response('Forbidden', { status: 403 });
		}
		if (c.req.raw.headers.get('Upgrade') === 'websocket' && !hasValidWebSocketOrigin(c.req.raw, appOrigin)) {
			return new Response('Forbidden', { status: 403 });
		}
		const agentStub = agentRunnerNamespace.getByName(`agent:${projectId}`);
		const agentUrl = new URL(c.req.url);
		agentUrl.pathname = '/';
		const agentHeaders = new Headers(c.req.raw.headers);
		agentHeaders.set('x-partykit-room', `agent:${projectId}`);
		agentHeaders.set('x-worker-ide-user-id', userId);
		agentHeaders.set('x-worker-ide-base-domain', parseHost(requestUrl.host).baseDomain);
		agentHeaders.set('x-worker-ide-protocol', agentUrl.protocol);
		return agentStub.fetch(new Request(agentUrl, { ...c.req.raw, headers: agentHeaders }));
	}

	return withMounts(async () => {
		mount(PROJECT_ROOT, fsStub);

		if (subPath === '/__ws' || subPath.startsWith('/__ws')) {
			if (!hasValidWebSocketOrigin(c.req.raw, appOrigin)) {
				return new Response('Forbidden', { status: 403 });
			}
			const { collaborationVisible } = c.get('session');
			const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
			const wsUrl = new URL(c.req.url);
			wsUrl.pathname = '/ws';
			const wsRequest = new Request(wsUrl, c.req.raw);
			wsRequest.headers.set('x-project-id', projectId);
			wsRequest.headers.set('x-worker-ide-client-kind', 'ide');
			wsRequest.headers.set('x-worker-ide-collaboration-visible', collaborationVisible ? 'true' : 'false');
			return coordinatorStub.fetch(wsRequest);
		}

		const projectApp = new Hono<AppEnvironment>();

		projectApp.use('*', async (context, innerNext) => {
			context.set('session', c.get('session'));
			context.set('projectId', projectId);
			context.set('projectRoot', PROJECT_ROOT);
			context.set('fsStub', fsStub);
			await innerNext();
		});

		if (import.meta.env.DEV) {
			projectApp.route('/api', developmentTestRoutes);
		}

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
				return composeResponseMiddleware(request, async () => {
					const secret = import.meta.env.DEV ? environment.PREVIEW_SECRET || DEV_PREVIEW_SECRET : environment.PREVIEW_SECRET;
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
					if (environment.PREVIEW_RATE_LIMITER) {
						const { success } = await environment.PREVIEW_RATE_LIMITER.limit({ key: parsed.projectId });
						if (!success) {
							return new Response('Too Many Requests', { status: 429 });
						}
					}

					return handlePreviewRequest(request, parsed.projectId, parsed.token);
				}, [previewRobotsHeadersMiddleware]);
			}

			case 'git': {
				// Proxy Git Smart HTTP v2 requests to the git auxiliary worker.
				// JWT verification is handled by the git worker itself.
				return environment.GIT_WORKER.fetch(request);
			}

			case 'app': {
				return composeResponseMiddleware(request, async () => app.fetch(request, environment, executionContext), [
					appSecurityHeadersMiddleware,
				]);
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
	 * Lifecycle cleanup:
	 * 1. Auto soft-delete projects older than PROJECT_INACTIVITY_DAYS (1 year).
	 * 2. Permanently purge projects, organizations, and users soft-deleted more than
	 *    SOFT_DELETE_RETENTION_DAYS (30 days) ago.
	 */
	async scheduled(_event: ScheduledEvent, environment: Env, _executionContext: ExecutionContext): Promise<void> {
		const database = drizzle(environment.DB, { schema: authSchema });
		const now = new Date();

		// Phase 1: Auto soft-delete projects older than 1 year
		const inactivityCutoff = new Date(now.getTime() - PROJECT_INACTIVITY_DAYS * 24 * 60 * 60 * 1000);
		const staleProjects = await database
			.select({ id: authSchema.project.id })
			.from(authSchema.project)
			.where(and(isNull(authSchema.project.deletedAt), lte(authSchema.project.lastActivityAt, inactivityCutoff)));

		if (staleProjects.length > 0) {
			console.log(`Auto soft-deleting ${staleProjects.length} project(s) older than ${PROJECT_INACTIVITY_DAYS} days`);
			for (const project of staleProjects) {
				await database.batch([
					database
						.update(authSchema.project)
						.set({ deletedAt: now, deletedViaType: PROJECT_DELETED_VIA_PROJECT, deletedViaId: project.id, updatedAt: now })
						.where(eq(authSchema.project.id, project.id)),
					database
						.update(authSchema.projectTransfer)
						.set({ status: 'cancelled', resolvedAt: now })
						.where(and(eq(authSchema.projectTransfer.projectId, project.id), eq(authSchema.projectTransfer.status, 'pending'))),
				]);
			}
		}

		// Phase 2: Permanently purge projects soft-deleted more than 30 days ago
		const purgeCutoff = new Date(now.getTime() - SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
		const expiredProjects = await database
			.select({ id: authSchema.project.id, durableObjectHexId: authSchema.project.durableObjectHexId })
			.from(authSchema.project)
			.where(and(isNotNull(authSchema.project.deletedAt), lte(authSchema.project.deletedAt, purgeCutoff)));

		if (expiredProjects.length > 0) {
			console.log(`Purging ${expiredProjects.length} soft-deleted project(s)`);

			for (const project of expiredProjects) {
				const deleted = await hardDeleteProjectById(database, project);
				if (!deleted) {
					continue;
				}

				console.log(`Purged project ${project.id}`);
			}
		}

		const expiredOrganizations = await database
			.select({ id: authSchema.organization.id })
			.from(authSchema.organization)
			.where(and(isNotNull(authSchema.organization.deletedAt), lte(authSchema.organization.deletedAt, purgeCutoff)));

		if (expiredOrganizations.length > 0) {
			console.log(`Purging ${expiredOrganizations.length} soft-deleted organization(s)`);

			for (const organization of expiredOrganizations) {
				const deleted = await hardDeleteOrganizationById(database, organization.id);
				if (!deleted) {
					console.warn(`Skipped purging organization ${organization.id} because one or more projects could not be fully deleted.`);
					continue;
				}

				console.log(`Purged organization ${organization.id}`);
			}
		}

		const expiredUsers = await database
			.select({ id: authSchema.user.id })
			.from(authSchema.user)
			.where(and(isNotNull(authSchema.user.deletedAt), lte(authSchema.user.deletedAt, purgeCutoff)));

		if (expiredUsers.length > 0) {
			console.log(`Purging ${expiredUsers.length} soft-deleted user(s)`);

			for (const user of expiredUsers) {
				const softDeletedOrgMemberships = await database
					.select({ organizationId: authSchema.member.organizationId })
					.from(authSchema.member)
					.innerJoin(authSchema.organization, eq(authSchema.organization.id, authSchema.member.organizationId))
					.where(and(eq(authSchema.member.userId, user.id), isNotNull(authSchema.organization.deletedAt)));

				if (softDeletedOrgMemberships.length > 0) {
					console.warn(`Skipped purging user ${user.id} because they still belong to soft-deleted organizations awaiting final cleanup.`);
					continue;
				}

				await database.delete(authSchema.user).where(eq(authSchema.user.id, user.id));
				console.log(`Purged user ${user.id}`);
			}
		}
	},
};

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
