import { Hono } from 'hono';

import { buildGitOrigin, parseHost } from '@shared/domain';
import { HttpErrorCode } from '@shared/http-errors';

import { httpError } from '../lib/http-error';

import type { AppEnvironment } from '../types';

export const gitCredentialRoutes = new Hono<AppEnvironment>()
	.get('/git/remote', (c) => {
		const projectId = c.get('projectId');
		const url = new URL(c.req.url);
		const { baseDomain } = parseHost(url.host);
		const gitOrigin = buildGitOrigin(baseDomain, url.protocol);
		const repoId = `ide/${projectId}`;

		return c.json({
			cloneUrl: `${gitOrigin}/${repoId}`,
			repoId,
		});
	})

	/**
	 * POST /api/git/credentials — Generate a short-lived read-only git token.
	 *
	 * Returns a 1-hour JWT that can be used with `git clone` via HTTP Basic Auth:
	 *   git clone https://t:<token>@git.<domain>/ide/<projectId>
	 */
	.post('/git/credentials', async (c) => {
		const projectId = c.get('projectId');
		const url = new URL(c.req.url);
		const { baseDomain } = parseHost(url.host);
		const gitOrigin = buildGitOrigin(baseDomain, url.protocol);
		const repoId = `ide/${projectId}`;

		const scopes = ['git:read'];

		try {
			const { token, expiresAt } = await c.env.GIT_WORKER.signJwt({
				sub: repoId,
				scopes,
			});

			return c.json({
				token,
				expiresAt,
				cloneUrl: `${gitOrigin}/${repoId}`,
				username: 't',
			});
		} catch (error) {
			console.error('Failed to sign git JWT:', error);
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to generate git credentials');
		}
	});

export type GitCredentialRoutes = typeof gitCredentialRoutes;
