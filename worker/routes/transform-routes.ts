/**
 * Code transformation routes.
 * Handles TypeScript/JSX compilation and bundling via esbuild-wasm.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { transformCodeSchema } from '@shared/validation';

import { httpError } from '../lib/http-error';
import { transformCode } from '../services/bundler-service';

import type { AppEnvironment } from '../types';

/**
 * Transform routes - all routes are prefixed with /api
 */
export const transformRoutes = new Hono<AppEnvironment>()
	// POST /api/transform - Transform TypeScript/JSX code to JavaScript
	.post('/transform', zValidator('json', transformCodeSchema), async (c) => {
		const { code, filename } = c.req.valid('json');

		try {
			const result = await transformCode(code, filename, { sourcemap: true });
			return c.json({
				code: result.code,
				map: result.map,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Transform failed';
			throw httpError(500, message);
		}
	});

export type TransformRoutes = typeof transformRoutes;
