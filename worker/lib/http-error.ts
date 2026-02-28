/**
 * HTTP Error Helper
 *
 * Throws an HTTPException with a JSON `{ error: string }` response body.
 * Using HTTPException instead of `c.json({ error }, status)` keeps error
 * responses out of Hono's typed route schema, giving the RPC client clean
 * single-type responses without union pollution.
 */

import { HTTPException } from 'hono/http-exception';

import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Throw an HTTP error with a JSON body.
 *
 * @param status - HTTP status code (e.g. 400, 404, 500)
 * @param message - Human-readable error message
 *
 * @example
 * ```ts
 * // Instead of:
 * return c.json({ error: 'Not found' }, 404);
 *
 * // Use:
 * throw httpError(404, 'Not found');
 * ```
 */
export function httpError(status: ContentfulStatusCode, message: string): HTTPException {
	return new HTTPException(status, {
		res: Response.json(
			{ error: message },
			{
				status,
				headers: { 'Content-Type': 'application/json' },
			},
		),
	});
}
