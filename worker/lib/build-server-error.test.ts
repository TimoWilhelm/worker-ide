import { describe, expect, it } from 'vitest';

import { cleanBuildErrorMessage, toBundleServerError } from './build-server-error';

describe('cleanBuildErrorMessage', () => {
	it('strips plugin prefixes and ERROR markers', () => {
		expect(cleanBuildErrorMessage('[plugin: virtual-fs] ERROR: Unexpected token')).toBe('Unexpected token');
	});

	it('leaves a plain message untouched', () => {
		expect(cleanBuildErrorMessage('Something went wrong')).toBe('Something went wrong');
	});
});

describe('toBundleServerError', () => {
	it('parses an esbuild file:line:col location', () => {
		const error = toBundleServerError(new Error('/app/page.tsx:3:10: ERROR: Expected ")" but found "}"'));
		expect(error.type).toBe('bundle');
		expect(error.message).toBe('Expected ")" but found "}"');
		expect(error.location).toEqual({ file: '/app/page.tsx', line: 3, column: 10 });
		expect(error.id).toBeTruthy();
		expect(typeof error.timestamp).toBe('number');
	});

	it('falls back to the raw message when there is no location', () => {
		const error = toBundleServerError('boom');
		expect(error.message).toBe('boom');
		expect(error.location).toBeUndefined();
	});
});
