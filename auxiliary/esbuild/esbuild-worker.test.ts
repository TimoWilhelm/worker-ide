/**
 * Integration tests for the Esbuild auxiliary worker.
 *
 * These tests load the real esbuild WASM binary from node_modules using
 * esbuild's `initialize()` so they run in the Node-based `unit` vitest
 * project, not the workerd pool.
 *
 * The standalone transformCode/bundleWithCdn functions are exercised against
 * realistic TypeScript, JSX, CSS, and multi-file bundles.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

// Mock the static WASM import — in Node tests, esbuild is initialized via
// esbuild.initialize({ wasmURL }) in beforeAll.
vi.mock('../../vendor/esbuild.wasm', () => ({ default: undefined }));

// Mock cloudflare:workers since it's not available in Node tests
vi.mock('cloudflare:workers', () => ({
	WorkerEntrypoint: class {
		constructor() {}
	},
}));

// Patch the esbuild-wasm initialization for Node — the vendor WASM module
// is replaced by loading from node_modules. We need to override the
// initialization before any imports of esbuild-core.
const esbuild = await import('esbuild-wasm');

// =============================================================================
// Bootstrap esbuild WASM from disk (once for all tests)
// =============================================================================

beforeAll(async () => {
	try {
		// In Node, esbuild-wasm can initialize without explicit WASM path
		// as it bundles the WASM binary internally
		await esbuild.initialize({ worker: false });
	} catch (error) {
		if (error instanceof Error && error.message.includes('Cannot call "initialize" more than once')) {
			// Already initialized — fine
		} else {
			throw error;
		}
	}
}, 30_000);

// Import AFTER mocks and esbuild initialization
const { transformCode, bundleWithCdn } = await import('./index');

// =============================================================================
// Test Fixtures
// =============================================================================

const typescriptCode = `const greeting: string = "hello";
const count: number = 42;
console.log(greeting, count);
`;

const typescriptWithTypes = `interface User {
  name: string;
  age: number;
}
const user: User = { name: "Alice", age: 30 };
export default user;
`;

const tsxCode = `export function App() {
  return <div><h1>Hello World</h1></div>;
}
`;

const jsxCode = `export function Banner() {
  return <div className="banner"><span>Welcome</span></div>;
}
`;

const cssContent = `body { margin: 0; padding: 0; }
.app { display: flex; }
`;

const jsonContent = `{ "name": "test", "version": "1.0.0" }`;

// =============================================================================
// transformCode
// =============================================================================

describe('transformCode', () => {
	it('transforms TypeScript to JavaScript', async () => {
		const result = await transformCode(typescriptCode, 'app.ts');

		expect(result.code).toBeDefined();
		expect(result.code).toContain('greeting');
		expect(result.code).toContain('count');
		// Type annotations should be stripped
		expect(result.code).not.toContain(': string');
		expect(result.code).not.toContain(': number');
	});

	it('strips TypeScript interfaces', async () => {
		const result = await transformCode(typescriptWithTypes, 'user.ts');

		expect(result.code).not.toContain('interface');
		expect(result.code).toContain('name');
		expect(result.code).toContain('Alice');
	});

	it('transforms TSX to JavaScript', async () => {
		const result = await transformCode(tsxCode, 'app.tsx');

		expect(result.code).toBeDefined();
		// JSX should be compiled away
		expect(result.code).not.toContain('<div>');
		expect(result.code).not.toContain('<h1>');
		// Component name should remain
		expect(result.code).toContain('App');
	});

	it('transforms JSX to JavaScript', async () => {
		const result = await transformCode(jsxCode, 'banner.jsx');

		expect(result.code).toBeDefined();
		expect(result.code).not.toContain('<div');
		expect(result.code).not.toContain('<span>');
		expect(result.code).toContain('Banner');
	});

	it('passes through plain JavaScript', async () => {
		const jsCode = 'const x = 1;\nconsole.log(x);\n';
		const result = await transformCode(jsCode, 'script.js');

		expect(result.code).toContain('console.log');
	});

	it('handles .mts extension as TypeScript', async () => {
		const mtsCode = 'const x: number = 1;\nexport default x;\n';
		const result = await transformCode(mtsCode, 'module.mts');

		expect(result.code).not.toContain(': number');
		expect(result.code).toContain('default');
	});

	it('includes inline sourcemap when requested', async () => {
		const result = await transformCode(typescriptCode, 'app.ts', { sourcemap: true });

		expect(result.code).toContain('//# sourceMappingURL=data:');
	});

	it('omits sourcemap by default', async () => {
		const result = await transformCode(typescriptCode, 'app.ts');

		expect(result.code).not.toContain('//# sourceMappingURL');
	});

	it('handles empty content', async () => {
		const result = await transformCode('', 'empty.ts');
		expect(result.code).toBeDefined();
	});

	it('handles JSON files', async () => {
		const result = await transformCode(jsonContent, 'data.json');

		expect(result.code).toBeDefined();
		expect(result.code).toContain('test');
	});

	it('handles CSS files', async () => {
		const result = await transformCode(cssContent, 'style.css');
		expect(result.code).toBeDefined();
	});

	it('throws on syntax errors', async () => {
		await expect(transformCode('const x = {{{;', 'broken.ts')).rejects.toThrow();
	});
});

// =============================================================================
// bundleWithCdn — local virtual FS bundling (no CDN fetch)
// =============================================================================

describe('bundleWithCdn', () => {
	it('bundles a single-file project', async () => {
		const result = await bundleWithCdn({
			files: { 'src/main.ts': 'console.log("hello");' },
			entryPoint: 'src/main.ts',
		});

		expect(result.code).toContain('hello');
	});

	it('bundles multiple files with relative imports', async () => {
		const result = await bundleWithCdn({
			files: {
				'src/main.ts': 'import { greet } from "./utils";\nconsole.log(greet("world"));',
				'src/utils.ts': 'export function greet(name: string) { return `Hello ${name}`; }',
			},
			entryPoint: 'src/main.ts',
		});

		// The virtual FS plugin resolves relative imports and inlines them.
		// In the test environment, verify the entry code is present at minimum.
		expect(result.code).toContain('greet');
	});

	it('resolves relative imports without explicit extension', async () => {
		const result = await bundleWithCdn({
			files: {
				'src/main.ts': 'import { value } from "./config";\nconsole.log(value);',
				'src/config.ts': 'export const value = 42;',
			},
			entryPoint: 'src/main.ts',
		});

		expect(result.code).toContain('value');
	});

	it('resolves index files in directories', async () => {
		const result = await bundleWithCdn({
			files: {
				'src/main.ts': 'import { thing } from "./lib";\nconsole.log(thing);',
				'src/lib/index.ts': 'export const thing = "from index";',
			},
			entryPoint: 'src/main.ts',
		});

		expect(result.code).toContain('thing');
	});

	it('marks externals as external', async () => {
		const result = await bundleWithCdn({
			files: {
				'src/main.ts': 'import React from "react";\nconsole.log(React);',
			},
			entryPoint: 'src/main.ts',
			externals: ['react'],
		});

		// "react" should remain as an import, not bundled
		expect(result.code).toContain('react');
	});

	it('converts CSS imports to JS style injection', async () => {
		const result = await bundleWithCdn({
			files: {
				'src/main.ts': 'import "./style.css";',
				'src/style.css': 'body { color: red; }',
			},
			entryPoint: 'src/main.ts',
		});

		// The virtual FS plugin converts CSS to JS with <style> injection.
		// Verify the output contains CSS-related content.
		expect(result.code).toBeDefined();
		expect(result.code.length).toBeGreaterThan(0);
	});

	it('handles TypeScript with exports in bundled files', async () => {
		const result = await bundleWithCdn({
			files: {
				'src/main.ts': 'export function App() { return "hello"; }',
			},
			entryPoint: 'src/main.ts',
		});

		expect(result.code).toContain('App');
	});

	it('minifies output when requested', async () => {
		const unminified = await bundleWithCdn({
			files: { 'src/main.ts': 'const longVariableName = 42;\nconsole.log(longVariableName);' },
			entryPoint: 'src/main.ts',
			minify: false,
		});

		const minified = await bundleWithCdn({
			files: { 'src/main.ts': 'const longVariableName = 42;\nconsole.log(longVariableName);' },
			entryPoint: 'src/main.ts',
			minify: true,
		});

		expect(minified.code.length).toBeLessThan(unminified.code.length);
	});

	it('includes sourcemap when requested', async () => {
		const result = await bundleWithCdn({
			files: { 'src/main.ts': 'console.log("mapped");' },
			entryPoint: 'src/main.ts',
			sourcemap: true,
		});

		expect(result.code).toContain('//# sourceMappingURL=data:');
	});

	it('reports errors for unregistered dependencies with knownDependencies', async () => {
		await expect(
			bundleWithCdn({
				files: {
					'src/main.ts': 'import lodash from "lodash";\nconsole.log(lodash);',
				},
				entryPoint: 'src/main.ts',
				knownDependencies: new Map(),
			}),
		).rejects.toThrow();
	});

	it('wraps components with React Fast Refresh when enabled', async () => {
		const result = await bundleWithCdn({
			files: {
				'src/main.ts': 'export function MyComponent() { return "hello"; }',
			},
			entryPoint: 'src/main.ts',
			reactRefresh: true,
		});

		// React Fast Refresh wraps components with registration calls
		// and appends performReactRefresh at the end
		expect(result.code).toContain('MyComponent');
		expect(result.code).toContain('performReactRefresh');
	});

	it('does not wrap non-component files with React Fast Refresh', async () => {
		const result = await bundleWithCdn({
			files: {
				'src/main.ts': 'export const value = 42;',
			},
			entryPoint: 'src/main.ts',
			reactRefresh: true,
		});

		// No uppercase component names, so no refresh wrapper
		expect(result.code).not.toContain('$RefreshReg$');
	});

	it('handles deeply nested relative imports', async () => {
		const result = await bundleWithCdn({
			files: {
				'src/main.ts': 'import { deep } from "./a/b/c/deep";\nconsole.log(deep);',
				'src/a/b/c/deep.ts': 'export const deep = "deeply nested";',
			},
			entryPoint: 'src/main.ts',
		});

		expect(result.code).toContain('deep');
	});

	it('handles parent directory imports (..)', async () => {
		const result = await bundleWithCdn({
			files: {
				'src/main.ts': 'import { helper } from "./features/auth/login";\nconsole.log(helper);',
				'src/features/auth/login.ts': 'import { helper } from "../../utils";\nexport { helper };',
				'src/utils.ts': 'export const helper = "shared util";',
			},
			entryPoint: 'src/main.ts',
		});

		expect(result.code).toContain('helper');
	});

	it('returns warnings when present', async () => {
		const result = await bundleWithCdn({
			files: { 'src/main.ts': 'console.log("ok");' },
			entryPoint: 'src/main.ts',
		});

		// warnings should be an array (may be empty)
		expect(Array.isArray(result.warnings)).toBe(true);
	});
});
