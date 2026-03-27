/**
 * Git Smart HTTP v2 routes for the git auxiliary worker.
 *
 * Endpoints:
 * - GET  /:owner/:repo/info/refs  — capability advertisement
 * - POST /:owner/:repo/git-upload-pack  — fetch/clone (streaming)
 * - POST /:owner/:repo/git-receive-pack — push
 */

import { authenticateGitRequest, unauthorizedResponse } from '@git/auth/jwt';
import { asBodyInit, getRepoStub } from '@git/common';
import {
	capabilityAdvertisement,
	parseV2Command,
	pktLine,
	flushPkt,
	concatChunks,
	getHeadAndRefs,
	inflateAndParseHeader,
	parseTagTarget,
} from '@git/git';
import { handleFetchV2Streaming } from '@git/git/operations/upload-stream/index';
import { repoKey } from '@git/keys';
import { Hono } from 'hono';

import type { HeadInfo, Reference } from '@git/git';

type GitHonoEnvironment = { Bindings: GitWorkerEnvironment };

export const gitRoutes = new Hono<GitHonoEnvironment>();

// Reject owner/repo values containing path traversal or unsafe characters
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9._-]+$/;

gitRoutes.use('/:owner/:repo/*', async (context, next) => {
	const { owner, repo } = context.req.param();
	if (!SAFE_PATH_SEGMENT.test(owner) || !SAFE_PATH_SEGMENT.test(repo)) {
		return context.text('Invalid repository path\n', 400);
	}
	await next();
});

// ---------------------------------------------------------------------------
// GET /:owner/:repo/info/refs — capability advertisement
// ---------------------------------------------------------------------------
gitRoutes.get('/:owner/:repo/info/refs', async (context) => {
	const { owner, repo } = context.req.param();
	const service = context.req.query('service');
	const environment = context.env;

	if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
		return context.text('Missing or unsupported service\n', 400);
	}

	// Authenticate for receive-pack (push)
	if (service === 'git-receive-pack') {
		const { authenticated } = await authenticateGitRequest(environment, context.req.raw, repoKey(owner, repo), 'git:write');
		if (!authenticated) return unauthorizedResponse();
	}

	// Authenticate for upload-pack (clone/fetch)
	if (service === 'git-upload-pack') {
		const { authenticated } = await authenticateGitRequest(environment, context.req.raw, repoKey(owner, repo), 'git:read');
		if (!authenticated) return unauthorizedResponse();
	}

	return capabilityAdvertisement(environment, service, repoKey(owner, repo));
});

// ---------------------------------------------------------------------------
// POST /:owner/:repo/git-upload-pack — fetch/clone
// ---------------------------------------------------------------------------
gitRoutes.post('/:owner/:repo/git-upload-pack', async (context) => {
	const { owner, repo } = context.req.param();
	const environment = context.env;
	const request = context.req.raw;
	const repositoryId = repoKey(owner, repo);

	// Authenticate
	const { authenticated } = await authenticateGitRequest(environment, request, repositoryId, 'git:read');
	if (!authenticated) return unauthorizedResponse();

	const body = new Uint8Array(await request.arrayBuffer());
	const gitProtocol = request.headers.get('Git-Protocol') || '';
	const { command } = parseV2Command(body);

	// Require protocol v2
	if (!/version=2/.test(gitProtocol) && !command) {
		return context.text('Expected Git protocol v2 (set Git-Protocol: version=2)\n', 400);
	}

	if (command === 'ls-refs') {
		return handleLsReferences(environment, repositoryId, body);
	}

	if (command === 'fetch') {
		return handleFetchV2Streaming(environment, repositoryId, body, request.signal, {
			req: request,
			ctx: context.executionCtx as unknown as ExecutionContext,
		});
	}

	return context.text('Unsupported command or malformed request\n', 400);
});

// ---------------------------------------------------------------------------
// POST /:owner/:repo/git-receive-pack — push
// ---------------------------------------------------------------------------
gitRoutes.post('/:owner/:repo/git-receive-pack', async (context) => {
	const { owner, repo } = context.req.param();
	const environment = context.env;
	const request = context.req.raw;
	const repositoryId = repoKey(owner, repo);

	// Authenticate (requires git:write scope)
	const { authenticated } = await authenticateGitRequest(environment, request, repositoryId, 'git:write');
	if (!authenticated) return unauthorizedResponse();

	const stub = getRepoStub(environment, repositoryId);

	// Preflight: reject early if DO is busy unpacking
	try {
		const progress = await stub.getUnpackProgress();
		const queued = progress.queuedCount || 0;
		if (progress.unpacking === true && queued >= 1) {
			return new Response('Repository is busy unpacking; please retry shortly.\n', {
				status: 503,
				headers: {
					'Retry-After': '10',
					'Content-Type': 'text/plain; charset=utf-8',
				},
			});
		}
	} catch {
		// Continue even if progress check fails
	}

	const contentType = request.headers.get('Content-Type') || 'application/x-git-receive-pack-request';
	const response = await stub.fetch('https://do/receive', {
		method: 'POST',
		body: request.body,
		headers: { 'Content-Type': contentType },
		signal: request.signal,
	});

	const headers = new Headers(response.headers);
	if (!headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/x-git-receive-pack-result');
	}
	headers.set('Cache-Control', 'no-cache');

	// Publish push event to queue
	const changed = response.headers.get('X-Repo-Changed') === '1';
	if (changed) {
		try {
			await environment.GIT_EVENTS.send({
				type: 'push',
				repoId: repositoryId,
				timestamp: Date.now(),
			});
		} catch {
			// Queue publish is best-effort
		}
	}

	return new Response(response.body, { status: response.status, headers });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function handleLsReferences(environment: GitWorkerEnvironment, repositoryId: string, body: Uint8Array): Promise<Response> {
	let head: HeadInfo | undefined;
	let references: Reference[] = [];
	try {
		const result = await getHeadAndRefs(environment, repositoryId);
		head = result.head;
		references = result.refs;
	} catch {
		// Empty refs on error
	}

	// Parse ls-refs arguments
	const { args } = parseV2Command(body);
	const referencePrefixes: string[] = [];
	let wantPeel = false;
	for (const argument of args) {
		if (argument === 'peel') wantPeel = true;
		else if (argument.startsWith('ref-prefix ')) referencePrefixes.push(argument.slice('ref-prefix '.length));
	}

	// Filter refs by prefix, exclude ephemeral refs from external clients
	let filteredReferences = references.filter((reference) => !reference.name.startsWith('refs/ephemeral/'));
	if (referencePrefixes.length > 0) {
		filteredReferences = filteredReferences.filter((reference) => referencePrefixes.some((prefix) => reference.name.startsWith(prefix)));
	}

	// Optional peel of annotated tags
	const peeledByReference = new Map<string, string>();
	if (wantPeel) {
		try {
			const tagReferences = filteredReferences.filter((reference) => reference.name.startsWith('refs/tags/'));
			if (tagReferences.length > 0) {
				const stub = getRepoStub(environment, repositoryId);
				// Use getObject (checks R2 + DO) instead of getObjectsBatch (DO-only)
				// so tag objects that only exist in R2/packs are still found.
				for (const reference of tagReferences) {
					try {
						const compressed = await stub.getObject(reference.oid);
						if (!compressed) continue;
						const parsed = await inflateAndParseHeader(compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed));
						if (!parsed) continue;
						if (parsed.type === 'tag') {
							const peeled = parseTagTarget(parsed.payload);
							if (peeled?.targetOid) peeledByReference.set(reference.name, peeled.targetOid);
						}
					} catch {
						// Best-effort per tag
					}
				}
			}
		} catch {
			// Best-effort peel
		}
	}

	const chunks: Uint8Array[] = [];

	// HEAD first
	if (head?.target) {
		const targetReference =
			filteredReferences.find((reference) => reference.name === head.target) ??
			references.find((reference) => reference.name === head.target);
		const headOid = head.oid ?? targetReference?.oid;
		const attributes = [`symref-target:${head.target}`];
		if (headOid) {
			chunks.push(pktLine(`${headOid} HEAD ${attributes.join(' ')}\n`));
		} else {
			chunks.push(pktLine(`unborn HEAD ${attributes.join(' ')}\n`));
		}
	}

	for (const reference of filteredReferences) {
		const attributes: string[] = [];
		if (wantPeel) {
			const peeled = peeledByReference.get(reference.name);
			if (peeled) attributes.push(`peeled:${peeled}`);
		}
		const line =
			attributes.length > 0 ? `${reference.oid} ${reference.name} ${attributes.join(' ')}` : `${reference.oid} ${reference.name}`;
		chunks.push(pktLine(`${line}\n`));
	}
	chunks.push(flushPkt());

	return new Response(asBodyInit(concatChunks(chunks)), {
		status: 200,
		headers: {
			'Content-Type': 'application/x-git-upload-pack-result',
			'Cache-Control': 'no-cache',
		},
	});
}
