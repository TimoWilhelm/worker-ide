import { describe, expect, it } from 'vitest';

import { toWorkerModulePart } from './deploy-helpers';

describe('toWorkerModulePart', () => {
	it('uploads .js/.mjs modules as ES modules unchanged', () => {
		const js = 'export default { fetch() {} };';
		expect(toWorkerModulePart('index.js', js)).toEqual({ contentType: 'application/javascript+module', body: js });
		expect(toWorkerModulePart('ssr/index.mjs', js)).toEqual({ contentType: 'application/javascript+module', body: js });
	});

	it('compiles .json modules into ES modules (never application/json)', () => {
		// The Workers Script Upload API rejects `application/json` module parts, so
		// JSON is emitted as `export default <value>` like Vite's json loader.
		const part = toWorkerModulePart('vinext-server.json', '{"prerenderSecret":"abc"}');
		expect(part.contentType).toBe('application/javascript+module');
		expect(part.contentType).not.toBe('application/json');
		expect(part.body).toBe('export default {"prerenderSecret":"abc"};\n');
	});

	it('handles array and empty .json bodies', () => {
		expect(toWorkerModulePart('vinext-externals.json', '[]').body).toBe('export default [];\n');
		expect(toWorkerModulePart('image-config.json', '{}').body).toBe('export default {};\n');
		// An empty/invalid-JSON file becomes a defined module rather than a syntax error.
		expect(toWorkerModulePart('empty.json', '   ').body).toBe('export default null;\n');
	});

	it('uploads extensionless manifests and CSS as text modules', () => {
		expect(toWorkerModulePart('BUILD_ID', 'abc123')).toEqual({ contentType: 'text/plain', body: 'abc123' });
		expect(toWorkerModulePart('index.css', 'body{}')).toEqual({ contentType: 'text/plain', body: 'body{}' });
	});
});
