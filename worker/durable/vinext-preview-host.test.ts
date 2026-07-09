import { describe, expect, it } from 'vitest';

import { parseRuntimeBuild } from './vinext-preview-host';

/**
 * `parseRuntimeBuild` is the safety gate on the persistent (R2) build cache: a
 * corrupt or format-drifted payload must be rejected so the DO falls back to a
 * clean rebuild rather than serving a broken preview.
 */
describe('parseRuntimeBuild', () => {
	const validBuild = {
		mainModule: 'server.js',
		serverModules: { 'server.js': 'export default {}' },
		clientOutput: { '/index.html': '<!doctype html>' },
	};

	it('accepts a well-formed build and returns a normalized copy', () => {
		const parsed = parseRuntimeBuild(validBuild);
		expect(parsed).toEqual(validBuild);
	});

	it('accepts empty module maps', () => {
		const parsed = parseRuntimeBuild({ mainModule: 'main.js', serverModules: {}, clientOutput: {} });
		expect(parsed).toEqual({ mainModule: 'main.js', serverModules: {}, clientOutput: {} });
	});

	it('rejects non-object payloads', () => {
		// `JSON.parse` mirrors the real R2 path and yields the values without
		// tripping lint rules against literal `undefined`/`null` arguments.
		expect(parseRuntimeBuild(JSON.parse('null'))).toBeUndefined();
		expect(parseRuntimeBuild('not-a-build')).toBeUndefined();
		expect(parseRuntimeBuild(42)).toBeUndefined();
	});

	it('rejects payloads missing required fields', () => {
		expect(parseRuntimeBuild({ serverModules: {}, clientOutput: {} })).toBeUndefined();
		expect(parseRuntimeBuild({ mainModule: 'main.js', clientOutput: {} })).toBeUndefined();
		expect(parseRuntimeBuild({ mainModule: 'main.js', serverModules: {} })).toBeUndefined();
	});

	it('rejects a non-string mainModule', () => {
		expect(parseRuntimeBuild({ ...validBuild, mainModule: 123 })).toBeUndefined();
	});

	it('rejects module maps holding non-string values', () => {
		expect(parseRuntimeBuild({ ...validBuild, serverModules: { 'a.js': 1 } })).toBeUndefined();
		expect(parseRuntimeBuild({ ...validBuild, clientOutput: { '/a': { nested: 'x' } } })).toBeUndefined();
	});
});
