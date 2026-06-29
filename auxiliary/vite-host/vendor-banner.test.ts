import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const vendorDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * The vendored native-plugins bundle (vinext + plugin-rsc) contains CommonJS
 * dependencies that call `require("node:path")` and friends. Bundled to ESM,
 * esbuild routes those through its throwing `__require` shim unless a real
 * `require` exists. The vendor script prepends a `createRequire` banner so node
 * builtins resolve in the host worker isolate (which has no global `require`).
 *
 * Tests that import the bundle run under vitest, which supplies a global
 * `require`, so they would NOT catch a missing banner — this guard does.
 */
describe('vendored native-plugins bundle', () => {
	const source = readFileSync(path.join(vendorDirectory, 'vendor', 'native-plugins.mjs'), 'utf8');

	it('prepends a createRequire banner so node builtins resolve without a global require', () => {
		const head = source.slice(0, 400);
		expect(head).toContain("from 'node:module'");
		expect(head).toContain('createRequire');
		expect(head).toMatch(/var require = /);
	});

	it('contains no code-generation-from-strings (forbidden in workerd)', () => {
		// plugin-rsc's `evalValue` uses `new Function(...)` to evaluate static
		// literal arguments; the vendor step rewrites it to an acorn-based static
		// evaluator. workerd disallows `new Function`/`eval`, and tests can't catch
		// it (vitest permits code-gen), so guard the vendored output directly.
		expect(source).not.toMatch(/\bnew Function\s*\(/);
		expect(source).not.toMatch(/[^.\w]eval\s*\(/);
	});
});
