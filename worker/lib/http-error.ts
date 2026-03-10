/**
 * HTTP Error Helper
 *
 * Throws an HTTPException with a JSON `{ error: string, code: string }`
 * response body. Using HTTPException instead of `c.json({ error }, status)`
 * keeps error responses out of Hono's typed route schema, giving the RPC
 * client clean single-type responses without union pollution.
 *
 * The `code` field is a strongly typed `HttpErrorCode` from
 * `shared/http-errors.ts`, enabling the frontend to:
 * 1. Surface the server's descriptive error message to users
 * 2. Branch on error type for conditional UI (e.g. retry on rate limit)
 */

import { HTTPException } from 'hono/http-exception';

import { DEFAULT_STATUS_CODES, type HttpErrorCode } from '@shared/http-errors';

import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Throw an HTTP error with a typed error code and JSON body.
 *
 * The HTTP status code is inferred from `DEFAULT_STATUS_CODES[code]` but can
 * be overridden with the optional third parameter.
 *
 * @param code - Strongly typed error code (e.g. `HttpErrorCode.FILE_NOT_FOUND`)
 * @param message - Human-readable error message
 * @param status - Optional HTTP status code override
 *
 * @example
 * ```ts
 * // Status 404 inferred from HttpErrorCode.FILE_NOT_FOUND:
 * throw httpError(HttpErrorCode.FILE_NOT_FOUND, 'File not found: /src/app.ts');
 *
 * // Explicit status override:
 * throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Unexpected failure', 503);
 * ```
 */
export function httpError(code: HttpErrorCode, message: string, status?: ContentfulStatusCode): HTTPException {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- DEFAULT_STATUS_CODES values are valid HTTP status codes but typed as `number`
	const httpStatus = status ?? (DEFAULT_STATUS_CODES[code] as ContentfulStatusCode);
	return new HTTPException(httpStatus, {
		res: Response.json(
			{ error: message, code },
			{
				status: httpStatus,
				headers: { 'Content-Type': 'application/json' },
			},
		),
	});
}
