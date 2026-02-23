/**
 * Integration tests for the lint_check tool.
 *
 * Tests lint diagnostics reporting, clean file handling, fixable issue hints,
 * path validation, and error handling. Biome WASM is mocked since it
 * cannot load in the workerd test pool.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const memoryFs = createMemoryFs();

vi.mock('node:fs/promises', () => memoryFs.asMock());

// Mock the biome linter with controllable diagnostics
const biomeMock = vi.hoisted(() => ({
	diagnostics: [] as Array<{ line: number; rule: string; message: string; severity: string; fixable: boolean }>,
}));

vi.mock('../lib/biome-linter', () => ({
	lintFileForAgent: async () => biomeMock.diagnostics,
	formatLintDiagnostics: (diagnostics: Array<{ line: number; rule: string; message: string; severity: string; fixable: boolean }>) => {
		if (diagnostics.length === 0) return;

		const lines = diagnostics.map(
			(diagnostic) =>
				`  - line ${diagnostic.line}: ${diagnostic.message} (${diagnostic.rule})${diagnostic.fixable ? ' [auto-fixable]' : ''}`,
		);

		const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
		const warningCount = diagnostics.length - errorCount;

		const summary = [errorCount > 0 ? `${errorCount} error(s)` : '', warningCount > 0 ? `${warningCount} warning(s)` : '']
			.filter(Boolean)
			.join(', ');

		return `Lint diagnostics (${summary}):\n${lines.join('\n')}`;
	},
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./lint-check');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lint_check', () => {
	beforeEach(() => {
		memoryFs.reset();
		biomeMock.diagnostics = [];
	});

	// ── Clean file ────────────────────────────────────────────────────────

	it('reports no lint issues when file is clean', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/clean.ts`, 'const x = 1;');

		const result = await execute({ path: '/src/clean.ts' }, createMockSendEvent(), context());

		expect(result).toBe('No lint issues found in /src/clean.ts.');
	});

	// ── Diagnostics found ─────────────────────────────────────────────────

	it('reports lint diagnostics with line numbers and rules', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/app.ts`, 'var x = 1;\neval("bad");');
		biomeMock.diagnostics = [
			{ line: 1, rule: 'lint/style/noVar', message: 'Use const or let instead of var', severity: 'error', fixable: true },
			{ line: 2, rule: 'lint/security/noEval', message: 'eval is harmful', severity: 'error', fixable: false },
		];

		const result = await execute({ path: '/src/app.ts' }, createMockSendEvent(), context());

		expect(result).toContain('Found 2 lint issue(s) in /src/app.ts');
		expect(result).toContain('noVar');
		expect(result).toContain('noEval');
		expect(result).toContain('line 1');
		expect(result).toContain('line 2');
	});

	it('indicates fixable count and suggests lint_fix', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/fixable.ts`, 'var x = 1;');
		biomeMock.diagnostics = [
			{ line: 1, rule: 'lint/style/noVar', message: 'Use const or let instead of var', severity: 'error', fixable: true },
		];

		const result = await execute({ path: '/src/fixable.ts' }, createMockSendEvent(), context());

		expect(result).toContain('1 issue(s) can be auto-fixed with lint_fix');
	});

	it('does not suggest lint_fix when no issues are fixable', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/unfixable.ts`, 'eval("bad");');
		biomeMock.diagnostics = [{ line: 1, rule: 'lint/security/noEval', message: 'eval is harmful', severity: 'error', fixable: false }];

		const result = await execute({ path: '/src/unfixable.ts' }, createMockSendEvent(), context());

		expect(result).toContain('Found 1 lint issue(s)');
		expect(result).not.toContain('auto-fixed with lint_fix');
	});

	// ── Read-only (does not modify file) ──────────────────────────────────

	it('does not modify the file', async () => {
		const original = 'var x = 1;';
		memoryFs.seedFile(`${PROJECT_ROOT}/src/readonly.ts`, original);
		biomeMock.diagnostics = [
			{ line: 1, rule: 'lint/style/noVar', message: 'Use const or let instead of var', severity: 'error', fixable: true },
		];

		await execute({ path: '/src/readonly.ts' }, createMockSendEvent(), context());

		const entry = memoryFs.store.get(`${PROJECT_ROOT}/src/readonly.ts`);
		expect(entry?.content).toBe(original);
	});

	it('does not send any events', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/quiet.ts`, 'var x = 1;');
		biomeMock.diagnostics = [
			{ line: 1, rule: 'lint/style/noVar', message: 'Use const or let instead of var', severity: 'error', fixable: true },
		];
		const sendEvent = createMockSendEvent();

		await execute({ path: '/src/quiet.ts' }, sendEvent, context());

		expect(sendEvent.calls).toHaveLength(0);
	});

	// ── Mixed severity ───────────────────────────────────────────────────

	it('reports errors and warnings together', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/mixed.ts`, 'var x = 1;\n// TODO: fix this');
		biomeMock.diagnostics = [
			{ line: 1, rule: 'lint/style/noVar', message: 'Use const or let instead of var', severity: 'error', fixable: true },
			{ line: 2, rule: 'lint/nursery/noTodo', message: 'Avoid TODO comments', severity: 'warning', fixable: false },
		];

		const result = await execute({ path: '/src/mixed.ts' }, createMockSendEvent(), context());

		expect(result).toContain('Found 2 lint issue(s)');
		expect(result).toContain('error(s)');
		expect(result).toContain('warning(s)');
	});

	// ── Error cases ───────────────────────────────────────────────────────

	it('returns MISSING_INPUT for empty path', async () => {
		await expect(execute({ path: '' }, createMockSendEvent(), context())).rejects.toThrow('[MISSING_INPUT]');
	});

	it('returns INVALID_PATH for hidden paths', async () => {
		await expect(execute({ path: '/.agent/file.ts' }, createMockSendEvent(), context())).rejects.toThrow('[INVALID_PATH]');
	});

	it('returns INVALID_PATH for paths outside project root', async () => {
		await expect(execute({ path: '/../outside.ts' }, createMockSendEvent(), context())).rejects.toThrow('[INVALID_PATH]');
	});

	it('returns FILE_NOT_FOUND for missing file', async () => {
		await expect(execute({ path: '/missing.ts' }, createMockSendEvent(), context())).rejects.toThrow('[FILE_NOT_FOUND]');
	});
});
