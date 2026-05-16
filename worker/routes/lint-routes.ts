import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';
import { lintFileRequestSchema, lintSingleFixRequestSchema } from '@shared/validation';

import { httpError } from '../lib/http-error';
import { applySingleFix, fixFile, lintFile } from '../services/lint-service';

import type { AppEnvironment } from '../types';

export const lintRoutes = new Hono<AppEnvironment>()
	.post('/lint/check', zValidator('json', lintFileRequestSchema), async (c) => {
		const { path, content } = c.req.valid('json');

		try {
			const diagnostics = await lintFile(path, content);
			return c.json({ diagnostics });
		} catch {
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to lint file');
		}
	})
	.post('/lint/fix', zValidator('json', lintFileRequestSchema), async (c) => {
		const { path, content } = c.req.valid('json');

		const result = await fixFile(path, content);
		if ('failed' in result) {
			// Log internal reason for diagnostics but return a generic message so
			// we do not leak linter internals (paths, panic strings) to clients.
			console.warn('[lint-routes] fixFile failed:', result.reason);
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to format and fix file');
		}

		return c.json(result);
	})
	.post('/lint/apply-fix', zValidator('json', lintSingleFixRequestSchema), async (c) => {
		const { path, content, from, to } = c.req.valid('json');

		try {
			const fixedContent = await applySingleFix(path, content, from, to);
			return c.json({ fixedContent });
		} catch {
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to apply lint fix');
		}
	});

export type LintRoutes = typeof lintRoutes;
