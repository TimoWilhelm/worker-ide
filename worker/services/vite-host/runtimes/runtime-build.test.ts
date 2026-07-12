import { describe, expect, it } from 'vitest';

import { parseRuntimeBuild } from './runtime-build';

describe('parseRuntimeBuild', () => {
	const validBuild = {
		mainModule: 'server.js',
		serverModules: { 'server.js': 'export default {}' },
		clientOutput: { '/index.html': '<!doctype html>' },
	};

	it('accepts a well-formed build', () => {
		expect(parseRuntimeBuild(validBuild)).toEqual(validBuild);
	});

	it('rejects malformed payloads', () => {
		expect(parseRuntimeBuild(JSON.parse('null'))).toBeUndefined();
		expect(parseRuntimeBuild({ mainModule: 'main.js', serverModules: { 'a.js': 1 }, clientOutput: {} })).toBeUndefined();
		expect(parseRuntimeBuild({ serverModules: {}, clientOutput: {} })).toBeUndefined();
	});
});
