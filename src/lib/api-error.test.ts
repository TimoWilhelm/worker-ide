/**
 * Unit tests for ApiError class and throwApiError helper.
 */

import { describe, expect, it } from 'vitest';

import { ApiError, throwApiError } from './api-error';

describe('ApiError', () => {
	it('extends Error', () => {
		const error = new ApiError('test message', 404, 'NOT_FOUND');
		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(ApiError);
	});

	it('stores message, status, and code', () => {
		const error = new ApiError('File not found', 404, 'FILE_NOT_FOUND');
		expect(error.message).toBe('File not found');
		expect(error.status).toBe(404);
		expect(error.code).toBe('FILE_NOT_FOUND');
		expect(error.name).toBe('ApiError');
	});

	it('works without a code', () => {
		const error = new ApiError('Something failed', 500);
		expect(error.message).toBe('Something failed');
		expect(error.status).toBe(500);
		expect(error.code).toBeUndefined();
	});
});

describe('throwApiError', () => {
	it('parses { error, code } from response body', async () => {
		const response = Response.json(
			{ error: 'File not found: /src/app.ts', code: 'FILE_NOT_FOUND' },
			{
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			},
		);

		try {
			await throwApiError(response, 'Fallback');
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			const apiError = error as InstanceType<typeof ApiError>;
			expect(apiError.message).toBe('File not found: /src/app.ts');
			expect(apiError.code).toBe('FILE_NOT_FOUND');
			expect(apiError.status).toBe(404);
			return;
		}
		expect.unreachable('throwApiError should have thrown');
	});

	it('parses { error } without code', async () => {
		const response = Response.json(
			{ error: 'Something went wrong' },
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			},
		);

		try {
			await throwApiError(response, 'Fallback');
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			const apiError = error as InstanceType<typeof ApiError>;
			expect(apiError.message).toBe('Something went wrong');
			expect(apiError.code).toBeUndefined();
			expect(apiError.status).toBe(500);
		}
	});

	it('falls back to provided message when body is not JSON', async () => {
		const response = new Response('Not JSON', {
			status: 500,
			headers: { 'Content-Type': 'text/plain' },
		});

		try {
			await throwApiError(response, 'Fallback message');
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			const apiError = error as InstanceType<typeof ApiError>;
			expect(apiError.message).toBe('Fallback message');
			expect(apiError.code).toBeUndefined();
			expect(apiError.status).toBe(500);
		}
	});

	it('falls back when body is JSON but has no error field', async () => {
		const response = Response.json(
			{ message: 'different shape' },
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			},
		);

		try {
			await throwApiError(response, 'My fallback');
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			const apiError = error as InstanceType<typeof ApiError>;
			expect(apiError.message).toBe('My fallback');
			expect(apiError.code).toBeUndefined();
		}
	});

	it('falls back when body is empty', async () => {
		const response = new Response('', {
			status: 502,
		});

		try {
			await throwApiError(response, 'Gateway error');
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			const apiError = error as InstanceType<typeof ApiError>;
			expect(apiError.message).toBe('Gateway error');
			expect(apiError.status).toBe(502);
		}
	});
});
