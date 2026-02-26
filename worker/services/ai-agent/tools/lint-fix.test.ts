/**
 * Integration tests for the lint_fix tool.
 *
 * Tests lint fix application, no-issue scenarios, unfixable diagnostics,
 * path validation, and error handling. Biome WASM is mocked since it
 * cannot load in the workerd test pool.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

import type { FileChange } from '../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const memoryFs = createMemoryFs();

vi.mock('node:fs/promises', () => memoryFs.asMock());

vi.mock('../../../lib/durable-object-namespaces', () => ({
	coordinatorNamespace: {
		idFromName: () => ({ toString: () => 'mock-id' }),
		get: () => ({ triggerUpdate: async () => {} }),
	},
}));

// Mock the biome linter with realistic behavior
const biomeMock = vi.hoisted(() => ({
	fixResult: {
		fixedContent: '',
		fixCount: 0,
		remainingDiagnostics: [] as Array<{ line: number; column: number; rule: string; message: string; severity: string; fixable: boolean }>,
	},
}));

vi.mock('../lib/biome-linter', () => ({
	fixFileForAgent: async (_path: string, _content: string) => biomeMock.fixResult,
	lintFileForAgent: async () => biomeMock.fixResult.remainingDiagnostics,
	formatLintResultsForAgent: async () => {},
	formatLintDiagnostics: () => {},
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./lint-fix');

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

describe('lint_fix', () => {
	beforeEach(() => {
		memoryFs.reset();
		// Reset to a default "no-op fix" result
		biomeMock.fixResult = {
			fixedContent: '',
			fixCount: 0,
			remainingDiagnostics: [],
		};
	});

	// ── Successful fix ────────────────────────────────────────────────────

	it('applies fixes and returns diff stats', async () => {
		const original = 'var x = 1;\nvar y = 2;\n';
		const fixed = 'const x = 1;\nconst y = 2;\n';
		memoryFs.seedFile(`${PROJECT_ROOT}/src/app.ts`, original);
		biomeMock.fixResult = {
			fixedContent: fixed,
			fixCount: 2,
			remainingDiagnostics: [],
		};

		const result = await execute({ path: '/src/app.ts' }, createMockSendEvent(), context());

		expect(result).toHaveProperty('output');
		expect(result.metadata).toHaveProperty('linesAdded');
		expect(result.metadata).toHaveProperty('linesRemoved');
		expect(result.output).toContain('Fixed 2 lint issue(s)');
		// File should be updated in the memory fs
		const entry = memoryFs.store.get(`${PROJECT_ROOT}/src/app.ts`);
		expect(entry?.content).toBe(fixed);
	});

	it('sends file_changed event after fix', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/fix.ts`, 'var x = 1;');
		biomeMock.fixResult = {
			fixedContent: 'const x = 1;',
			fixCount: 1,
			remainingDiagnostics: [],
		};
		const sendEvent = createMockSendEvent();

		await execute({ path: '/fix.ts' }, sendEvent, context());

		const fileChangedEvent = sendEvent.calls.find(([type]) => type === 'file_changed');
		expect(fileChangedEvent).toBeDefined();
		expect(fileChangedEvent![1]).toHaveProperty('action', 'edit');
	});

	// ── No issues ─────────────────────────────────────────────────────────

	it('reports no lint issues when file is clean', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/clean.ts`, 'const x = 1;');
		biomeMock.fixResult = {
			fixedContent: 'const x = 1;',
			fixCount: 0,
			remainingDiagnostics: [],
		};

		const result = await execute({ path: '/clean.ts' }, createMockSendEvent(), context());

		expect(result.output).toContain('No lint issues found');
	});

	// ── Remaining diagnostics ─────────────────────────────────────────────

	it('reports remaining unfixable diagnostics', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/partial.ts`, 'var x = 1;\neval("bad");');
		biomeMock.fixResult = {
			fixedContent: 'const x = 1;\neval("bad");',
			fixCount: 1,
			remainingDiagnostics: [
				{ line: 2, column: 1, rule: 'lint/security/noEval', message: 'eval is harmful', severity: 'error', fixable: false },
			],
		};

		const result = await execute({ path: '/partial.ts' }, createMockSendEvent(), context());

		expect(result.output).toContain('1 issue(s) remain');
		expect(result.output).toContain('noEval');
	});

	it('reports unfixable issues when no auto-fixes are available', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/manual.ts`, 'eval("x")');
		biomeMock.fixResult = {
			fixedContent: 'eval("x")',
			fixCount: 0,
			remainingDiagnostics: [
				{ line: 1, column: 1, rule: 'lint/security/noEval', message: 'eval is harmful', severity: 'error', fixable: false },
			],
		};

		const result = await execute({ path: '/manual.ts' }, createMockSendEvent(), context());

		expect(result.output).toContain('require manual fixes');
	});

	// ── Snapshot tracking ─────────────────────────────────────────────────

	it('tracks fix in queryChanges', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/tracked.ts`, 'var x = 1;');
		biomeMock.fixResult = {
			fixedContent: 'const x = 1;',
			fixCount: 1,
			remainingDiagnostics: [],
		};
		const queryChanges: FileChange[] = [];

		await execute({ path: '/tracked.ts' }, createMockSendEvent(), context(), queryChanges);

		expect(queryChanges).toHaveLength(1);
		expect(queryChanges[0].action).toBe('edit');
		expect(queryChanges[0].beforeContent).toBe('var x = 1;');
		expect(queryChanges[0].afterContent).toBe('const x = 1;');
	});

	// ── Error cases ───────────────────────────────────────────────────────

	it('returns MISSING_INPUT for empty path', async () => {
		await expect(execute({ path: '' }, createMockSendEvent(), context())).rejects.toThrow('[MISSING_INPUT]');
	});

	it('returns INVALID_PATH for hidden paths', async () => {
		await expect(execute({ path: '/.agent/file.ts' }, createMockSendEvent(), context())).rejects.toThrow('[INVALID_PATH]');
	});

	it('returns FILE_NOT_FOUND for missing file', async () => {
		biomeMock.fixResult = {
			fixedContent: '',
			fixCount: 0,
			remainingDiagnostics: [],
		};

		await expect(execute({ path: '/missing.ts' }, createMockSendEvent(), context())).rejects.toThrow('[FILE_NOT_FOUND]');
	});

	it('handles biome fix failure', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/bad.ts`, 'content');
		// Override the hoisted mock to return a failure object
		biomeMock.fixResult = { failed: true, reason: 'Biome WASM init failed' } as unknown as typeof biomeMock.fixResult;

		await expect(execute({ path: '/bad.ts' }, createMockSendEvent(), context())).rejects.toThrow('[LINT_FIX_FAILED]');
	});
});
