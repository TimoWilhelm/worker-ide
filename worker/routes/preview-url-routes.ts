/**
 * Preview URL routes.
 * Generates HMAC-signed preview URLs with time-bucket tokens.
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';

import { buildPreviewOrigin, getBaseDomain } from '@shared/domain';
import { HttpErrorCode } from '@shared/http-errors';
import { generatePreviewToken } from '@shared/preview-token';

import { httpError } from '../lib/http-error';
import { DEV_PREVIEW_SECRET } from '../lib/preview-secret';

import type { AppEnvironment } from '../types';

/**
 * Preview URL routes - all routes are prefixed with /api
 */
export const previewUrlRoutes = new Hono<AppEnvironment>()
	/**
	 * GET /api/preview-url
	 *
	 * Returns a signed preview URL for the current project. The URL
	 * contains an HMAC token valid for 1–2 hours (current + previous
	 * time bucket).
	 *
	 * The frontend should call this once on IDE load and again whenever
	 * the preview iframe returns a 403 (token expired).
	 */
	.get('/preview-url', async (c) => {
		const projectId = c.get('projectId');

		// Rate-limit token generation per project to prevent token farming.
		if (env.PREVIEW_RATE_LIMITER) {
			const { success } = await env.PREVIEW_RATE_LIMITER.limit({ key: projectId });
			if (!success) {
				throw httpError(HttpErrorCode.RATE_LIMITED, 'Too many preview URL requests. Please wait before retrying.');
			}
		}

		const secret = env.PREVIEW_SECRET || DEV_PREVIEW_SECRET;

		const token = await generatePreviewToken(projectId, secret);

		const requestUrl = new URL(c.req.url);
		const baseDomain = getBaseDomain(requestUrl.host);
		const protocol = requestUrl.protocol;

		const previewOrigin = buildPreviewOrigin(projectId, token, baseDomain, protocol);
		const previewUrl = `${previewOrigin}/`;

		return c.json({ url: previewUrl, origin: previewOrigin });
	});

export type PreviewUrlRoutes = typeof previewUrlRoutes;
