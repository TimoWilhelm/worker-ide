import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';

import { HttpErrorCode } from '@shared/http-errors';

import { httpError } from './http-error';

describe('httpError', () => {
	it('returns an HTTPException', () => {
		const error = httpError(HttpErrorCode.NOT_FOUND, 'Resource not found');
		expect(error).toBeInstanceOf(HTTPException);
	});

	it('populates the Error message (not just the response body)', () => {
		// Regression: previously the message lived only in `res`, leaving
		// `error.message` empty. Consumers reading `error.message` directly (e.g.
		// the deploy workflow) then surfaced a blank error string.
		const error = httpError(HttpErrorCode.UPSTREAM_ERROR, 'Failed to deploy worker: script too large');
		expect(error.message).toBe('Failed to deploy worker: script too large');
	});

	it('keeps the JSON error body intact for route responses', async () => {
		const error = httpError(HttpErrorCode.VALIDATION_ERROR, 'Bad input');
		const body = await error.getResponse().json();
		expect(body).toEqual({ error: 'Bad input', code: HttpErrorCode.VALIDATION_ERROR });
	});

	it('honours an explicit status override', () => {
		const error = httpError(HttpErrorCode.INTERNAL_ERROR, 'Unexpected failure', 503);
		expect(error.status).toBe(503);
	});
});
