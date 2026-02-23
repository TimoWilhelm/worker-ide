/**
 * Integration tests for the Biome auxiliary worker.
 *
 * These tests load the real Biome WASM binary (~27 MiB) from disk using
 * `initSync` so they run in the Node-based `unit` vitest project, not the
 * workerd pool (which cannot host the WASM).
 *
 * The standalone lintFile/fixFile functions are exercised against real source
 * code in .ts, .tsx, and .js to verify actual lint detection, auto-fixing,
 * and diagnostic mapping.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { initSync } from '@biomejs/wasm-web';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Mock the static WASM import — in Node tests, the WASM is pre-loaded via
// initSync() in beforeAll, so the dynamic import in initBiome() short-circuits.
vi.mock('../../vendor/biome_wasm_bg.wasm', () => ({ default: undefined }));

// Mock cloudflare:workers since it's not available in Node tests
vi.mock('cloudflare:workers', () => ({
	WorkerEntrypoint: class {
		constructor() {}
	},
}));

import { fixFile, lintFile } from './index';

import type { FixFileFailure, ServerLintFixResult } from '@shared/biome-types';

// =============================================================================
// Bootstrap Biome WASM from disk (once for all tests)
// =============================================================================

beforeAll(() => {
	const wasmPath = path.resolve('node_modules/@biomejs/wasm-web/biome_wasm_bg.wasm');
	const wasmBytes = readFileSync(wasmPath);
	initSync({ module: wasmBytes });
}, 30_000);

// =============================================================================
// Test Fixtures — realistic source files with known lint issues
//
// Rules confirmed active in Biome's default recommended config:
//   - lint/suspicious/noDoubleEquals  (== → ===)     [fixable]
//   - lint/suspicious/noDebugger      (debugger)     [fixable]
//   - lint/complexity/noUselessRename ({a:a} → {a})  [fixable]
//   - lint/a11y/useAltText            (<img> no alt) [unfixable]
//   - lint/correctness/useValidTypeof ("strin")       [unfixable]
//   - lint/correctness/noUnusedVariables              [fixable]
//
// NOTE: lint/style/noVar is NOT in the default recommended rules.
// =============================================================================

/** TypeScript with == and != (noDoubleEquals — fixable) */
const tsWithDoubleEquals = `const value = 42;
if (value == "42") {
  console.log("match");
}
if (value != 0) {
  console.log("nonzero");
}
`;

/** TypeScript with debugger statement (noDebugger — fixable) */
const tsWithDebugger = `const x = 1;
debugger;
console.log(x);
`;

/** TypeScript with useless rename (noUselessRename — fixable) */
const tsWithUselessRename = `const { a: a } = { a: 1 };
console.log(a);
`;

/** TypeScript with both fixable and unfixable issues */
const tsWithMixedIssues = `const x = 42;
if (x == "42") {
  console.log(typeof x === "strin");
}
const { a: a } = { a: 1 };
if (x != 0) {
  console.log(a);
}
`;

/** TypeScript that is completely clean */
const tsClean = `const greeting = "hello";
const count = 0;
console.log(greeting, count);
`;

/** TSX with missing alt attribute on img (useAltText — unfixable) */
const tsxWithAccessibilityIssue = `export function Banner() {
  return <div><img src="banner.png" /></div>;
}
`;

/** TSX that is clean */
const tsxClean = `export function App() {
  return <div><p>Hello</p></div>;
}
`;

/** JSX with multiple fixable issues (== and debugger) */
const jsWithIssues = `const x = 1;
debugger;
if (x == 0) {
  console.log(x);
}
`;

/** JS that is clean */
const jsClean = `const x = 1;
console.log(x);
`;

// =============================================================================
// lintFile
// =============================================================================

describe('lintFile', () => {
	it('detects noDoubleEquals in a .ts file', async () => {
		const diagnostics = await lintFile('/equality.ts', tsWithDoubleEquals);

		expect(diagnostics.length).toBeGreaterThanOrEqual(2);

		const doubleEqualsDiagnostics = diagnostics.filter((d) => d.rule.includes('noDoubleEquals'));
		expect(doubleEqualsDiagnostics.length).toBe(2);

		for (const diagnostic of doubleEqualsDiagnostics) {
			expect(diagnostic.fixable).toBe(true);
			expect(diagnostic.severity).toBe('error');
			expect(diagnostic.message).toContain('unsafe');
		}
	});

	it('detects noDebugger in a .ts file', async () => {
		const diagnostics = await lintFile('/debug.ts', tsWithDebugger);

		const debuggerDiagnostics = diagnostics.filter((d) => d.rule.includes('noDebugger'));
		expect(debuggerDiagnostics.length).toBe(1);
		expect(debuggerDiagnostics[0].line).toBe(2);
	});

	it('returns empty array for a clean .ts file', async () => {
		const diagnostics = await lintFile('/clean.ts', tsClean);
		expect(diagnostics).toEqual([]);
	});

	it('detects useAltText in a .tsx file', async () => {
		const diagnostics = await lintFile('/banner.tsx', tsxWithAccessibilityIssue);

		const altTextDiagnostics = diagnostics.filter((d) => d.rule.includes('useAltText'));
		expect(altTextDiagnostics.length).toBe(1);
		expect(altTextDiagnostics[0].fixable).toBe(false);
		expect(altTextDiagnostics[0].severity).toBe('error');
	});

	it('returns empty array for a clean .tsx file', async () => {
		const diagnostics = await lintFile('/clean.tsx', tsxClean);
		expect(diagnostics).toEqual([]);
	});

	it('detects multiple issue types in a .js file', async () => {
		const diagnostics = await lintFile('/script.js', jsWithIssues);

		expect(diagnostics.length).toBeGreaterThanOrEqual(2);

		const ruleNames = diagnostics.map((d) => d.rule);
		expect(ruleNames.some((rule) => rule.includes('noDebugger'))).toBe(true);
		expect(ruleNames.some((rule) => rule.includes('noDoubleEquals'))).toBe(true);
	});

	it('returns empty array for a clean .js file', async () => {
		const diagnostics = await lintFile('/clean.js', jsClean);
		expect(diagnostics).toEqual([]);
	});

	it('returns empty array for unsupported file extensions', async () => {
		expect(await lintFile('/readme.md', '# Hello')).toEqual([]);
		expect(await lintFile('/script.py', 'print("hello")')).toEqual([]);
		expect(await lintFile('/data.yaml', 'key: value')).toEqual([]);
	});

	it('returns correct 1-based line numbers', async () => {
		const diagnostics = await lintFile('/debug.ts', tsWithDebugger);
		const debuggerDiagnostic = diagnostics.find((d) => d.rule.includes('noDebugger'));

		expect(debuggerDiagnostic).toBeDefined();
		// `debugger;` is on line 2 (1-based)
		expect(debuggerDiagnostic!.line).toBe(2);
	});

	it('populates all diagnostic fields correctly', async () => {
		const diagnostics = await lintFile('/equality.ts', tsWithDoubleEquals);
		expect(diagnostics.length).toBeGreaterThan(0);

		for (const diagnostic of diagnostics) {
			expect(typeof diagnostic.line).toBe('number');
			expect(diagnostic.line).toBeGreaterThanOrEqual(1);
			expect(typeof diagnostic.column).toBe('number');
			expect(diagnostic.column).toBeGreaterThanOrEqual(1);
			expect(typeof diagnostic.rule).toBe('string');
			expect(diagnostic.rule.length).toBeGreaterThan(0);
			expect(typeof diagnostic.message).toBe('string');
			expect(diagnostic.message.length).toBeGreaterThan(0);
			expect(['error', 'warning']).toContain(diagnostic.severity);
			expect(typeof diagnostic.fixable).toBe('boolean');
		}
	});

	it('distinguishes fixable from unfixable diagnostics', async () => {
		const diagnostics = await lintFile('/mixed.ts', tsWithMixedIssues);

		const fixable = diagnostics.filter((d) => d.fixable);
		const unfixable = diagnostics.filter((d) => !d.fixable);

		// noDoubleEquals (== and !=) and noUselessRename are fixable
		expect(fixable.length).toBeGreaterThanOrEqual(1);
		// useValidTypeof ("strin") is unfixable
		expect(unfixable.length).toBeGreaterThanOrEqual(1);
	});
});

// =============================================================================
// fixFile
// =============================================================================

describe('fixFile', () => {
	it('fixes == to === in a .ts file', async () => {
		const result = await fixFile('/equality.ts', tsWithDoubleEquals);

		expect('failed' in result).toBe(false);
		const fixResult = result as ServerLintFixResult;

		expect(fixResult.fixCount).toBeGreaterThanOrEqual(2);
		expect(fixResult.fixedContent).toContain('===');
		expect(fixResult.fixedContent).toContain('!==');
		expect(fixResult.fixedContent).not.toContain(' == ');
		expect(fixResult.fixedContent).not.toContain(' != ');
	});

	it('removes debugger statement in a .ts file', async () => {
		const result = await fixFile('/debug.ts', tsWithDebugger);

		expect('failed' in result).toBe(false);
		const fixResult = result as ServerLintFixResult;

		expect(fixResult.fixCount).toBeGreaterThanOrEqual(1);
		expect(fixResult.fixedContent).not.toContain('debugger');
		// Should preserve the surrounding code
		expect(fixResult.fixedContent).toContain('const x = 1;');
		expect(fixResult.fixedContent).toContain('console.log(x);');
	});

	it('fixes useless rename in a .ts file', async () => {
		const result = await fixFile('/rename.ts', tsWithUselessRename);

		expect('failed' in result).toBe(false);
		const fixResult = result as ServerLintFixResult;

		expect(fixResult.fixCount).toBeGreaterThanOrEqual(1);
		// { a: a } should become { a }
		expect(fixResult.fixedContent).toContain('{ a }');
		expect(fixResult.fixedContent).not.toContain('{ a: a }');
	});

	it('returns fixCount 0 for a clean .ts file', async () => {
		const result = await fixFile('/clean.ts', tsClean);

		expect('failed' in result).toBe(false);
		const fixResult = result as ServerLintFixResult;

		expect(fixResult.fixCount).toBe(0);
		expect(fixResult.fixedContent).toBe(tsClean);
		expect(fixResult.remainingDiagnostics).toEqual([]);
	});

	it('fixes multiple issue types in a .js file', async () => {
		const result = await fixFile('/script.js', jsWithIssues);

		expect('failed' in result).toBe(false);
		const fixResult = result as ServerLintFixResult;

		expect(fixResult.fixCount).toBeGreaterThanOrEqual(2);
		expect(fixResult.fixedContent).not.toContain('debugger');
		expect(fixResult.fixedContent).toContain('===');
	});

	it('fixes fixable issues and reports remaining unfixable ones', async () => {
		const result = await fixFile('/mixed.ts', tsWithMixedIssues);

		expect('failed' in result).toBe(false);
		const fixResult = result as ServerLintFixResult;

		// Should fix == → ===, != → !==, {a: a} → {a}
		expect(fixResult.fixCount).toBeGreaterThanOrEqual(1);
		expect(fixResult.fixedContent).toContain('===');
		expect(fixResult.fixedContent).toContain('!==');
		expect(fixResult.fixedContent).toContain('{ a }');

		// useValidTypeof ("strin") should remain as unfixable
		expect(fixResult.remainingDiagnostics.length).toBeGreaterThanOrEqual(1);
		const unfixableRule = fixResult.remainingDiagnostics.find((d) => d.rule.includes('useValidTypeof'));
		expect(unfixableRule).toBeDefined();
		expect(unfixableRule!.fixable).toBe(false);
	});

	it('returns FixFileFailure for unsupported file types', async () => {
		const result = await fixFile('/readme.md', '# Hello');

		expect('failed' in result).toBe(true);
		const failure = result as FixFileFailure;
		expect(failure.failed).toBe(true);
		expect(failure.reason).toContain('not supported');
	});

	it('produces valid content that can be re-linted without crashing', async () => {
		const result = await fixFile('/equality.ts', tsWithDoubleEquals);
		expect('failed' in result).toBe(false);
		const fixResult = result as ServerLintFixResult;

		// Re-lint the fixed content — should not crash
		const reLintDiagnostics = await lintFile('/equality.ts', fixResult.fixedContent);

		// After full fix, remaining diagnostics should match fixFile's report
		expect(reLintDiagnostics.length).toBe(fixResult.remainingDiagnostics.length);
	});

	it('handles TSX files with only unfixable issues', async () => {
		const result = await fixFile('/banner.tsx', tsxWithAccessibilityIssue);

		expect('failed' in result).toBe(false);
		const fixResult = result as ServerLintFixResult;

		// useAltText is unfixable, so the content should be unchanged or
		// only other fixable issues are resolved
		expect(fixResult.remainingDiagnostics.length).toBeGreaterThanOrEqual(1);
		expect(fixResult.remainingDiagnostics.some((d) => d.rule.includes('useAltText'))).toBe(true);
	});

	it('does not crash on empty content', async () => {
		const result = await fixFile('/empty.ts', '');
		expect('failed' in result).toBe(false);
		const fixResult = result as ServerLintFixResult;
		expect(fixResult.fixCount).toBe(0);
	});

	it('handles content with syntax errors gracefully', async () => {
		const result = await fixFile('/broken.ts', 'const x = {{{;');
		// Should either return a valid result or a failure — not throw
		expect(result).toBeDefined();
	});
});
