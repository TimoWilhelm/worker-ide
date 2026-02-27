/**
 * Integration tests for the file_move tool.
 *
 * Tests move/rename, protected file guards, path validation,
 * and snapshot tracking against an in-memory filesystem.
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

// Biome linter — return empty diagnostics by default (overridable per-test)
const lintMock = vi.hoisted(() => ({
	diagnostics: [] as Array<{ line: number; column: number; rule: string; message: string; severity: string; fixable: boolean }>,
}));

vi.mock('../lib/biome-linter', () => ({
	lintFileForAgent: async () => lintMock.diagnostics,
	formatLintDiagnostics: (diagnostics: Array<{ severity: string; line: number; column: number; message: string; fixable: boolean }>) => {
		if (diagnostics.length === 0) return;
		return `Lint diagnostics (${diagnostics.length} issue(s)):\n${diagnostics.map((d) => `${d.severity === 'error' ? 'Error' : 'Warning'} [${d.line}:${d.column}] ${d.message}${d.fixable ? ' [auto-fixable]' : ''}`).join('\n')}`;
	},
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./file-move');

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

describe('file_move', () => {
	beforeEach(() => {
		memoryFs.reset();
		lintMock.diagnostics = [];
	});

	// ── Successful moves ──────────────────────────────────────────────────

	it('moves a file to a new location', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/old.ts`, 'file content');

		const result = await execute({ from_path: '/old.ts', to_path: '/new.ts' }, createMockSendEvent(), context());

		expect(result).toHaveProperty('output');
		expect(result.metadata).toHaveProperty('from', '/old.ts');
		expect(result.metadata).toHaveProperty('to', '/new.ts');
		expect(memoryFs.store.has(`${PROJECT_ROOT}/old.ts`)).toBe(false);
		expect(memoryFs.store.has(`${PROJECT_ROOT}/new.ts`)).toBe(true);
	});

	it('moves a file into a new directory', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/file.ts`, 'content');

		const result = await execute({ from_path: '/file.ts', to_path: '/src/components/file.ts' }, createMockSendEvent(), context());

		expect(result).toHaveProperty('output');
		expect(memoryFs.store.has(`${PROJECT_ROOT}/src/components/file.ts`)).toBe(true);
	});

	it('preserves file content after move', async () => {
		const originalContent = 'export const value = 42;\n';
		memoryFs.seedFile(`${PROJECT_ROOT}/original.ts`, originalContent);

		await execute({ from_path: '/original.ts', to_path: '/moved.ts' }, createMockSendEvent(), context());

		const entry = memoryFs.store.get(`${PROJECT_ROOT}/moved.ts`);
		expect(entry?.content).toBe(originalContent);
	});

	// ── Snapshot tracking ─────────────────────────────────────────────────

	it('tracks move as delete + create in queryChanges', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/source.ts`, 'content');
		const queryChanges: FileChange[] = [];

		await execute({ from_path: '/source.ts', to_path: '/dest.ts' }, createMockSendEvent(), context(), queryChanges);

		expect(queryChanges).toHaveLength(2);
		expect(queryChanges[0].action).toBe('delete');
		expect(queryChanges[0].path).toBe('/source.ts');
		expect(queryChanges[1].action).toBe('create');
		expect(queryChanges[1].path).toBe('/dest.ts');
	});

	// ── Event emission ────────────────────────────────────────────────────

	it('sends file_changed event with move info', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/a.ts`, 'x');
		const sendEvent = createMockSendEvent();

		await execute({ from_path: '/a.ts', to_path: '/b.ts' }, sendEvent, context());

		const fileChangedEvent = sendEvent.calls.find(([type]) => type === 'file_changed');
		expect(fileChangedEvent).toBeDefined();
		expect(fileChangedEvent![1]).toHaveProperty('action', 'move');
	});

	// ── Error cases ───────────────────────────────────────────────────────

	it('returns FILE_NOT_FOUND when source does not exist', async () => {
		await expect(execute({ from_path: '/missing.ts', to_path: '/dest.ts' }, createMockSendEvent(), context())).rejects.toThrow(
			'[FILE_NOT_FOUND]',
		);
	});

	it('rejects path traversal in from_path', async () => {
		await expect(execute({ from_path: '/../escape.ts', to_path: '/dest.ts' }, createMockSendEvent(), context())).rejects.toThrow(
			'[INVALID_PATH]',
		);
	});

	it('rejects path traversal in to_path', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/ok.ts`, 'content');

		await expect(execute({ from_path: '/ok.ts', to_path: '/../escape.ts' }, createMockSendEvent(), context())).rejects.toThrow(
			'[INVALID_PATH]',
		);
	});

	it('rejects hidden paths', async () => {
		await expect(execute({ from_path: '/.agent/data.json', to_path: '/data.json' }, createMockSendEvent(), context())).rejects.toThrow(
			'[INVALID_PATH]',
		);
	});

	it('rejects moving protected files', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/index.html`, '<html></html>');

		await expect(execute({ from_path: '/index.html', to_path: '/old-index.html' }, createMockSendEvent(), context())).rejects.toThrow(
			'[NOT_ALLOWED]',
		);
	});

	// ── Diagnostics ──────────────────────────────────────────────────────

	it('includes diagnostics in metadata after move', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/component.ts`, 'var x = 1;\n');
		lintMock.diagnostics = [
			{ line: 1, column: 1, rule: 'lint/style/noVar', message: 'Use const or let', severity: 'error', fixable: true },
		];

		const result = await execute({ from_path: '/src/component.ts', to_path: '/src/renamed.ts' }, createMockSendEvent(), context());

		expect(result.metadata).toHaveProperty('diagnostics');
		expect(result.metadata.diagnostics).toHaveLength(1);
		expect(result.metadata.diagnostics[0]).toHaveProperty('rule', 'lint/style/noVar');
		expect(result.output).toContain('Use const or let');
	});

	it('caps diagnostics at MAX_DIAGNOSTICS_PER_FILE (20)', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/many.ts`, 'content\n');
		lintMock.diagnostics = Array.from({ length: 25 }, (_, index) => ({
			line: index + 1,
			column: 1,
			rule: 'lint/style/noVar',
			message: `Issue ${index + 1}`,
			severity: 'error' as const,
			fixable: false,
		}));

		const result = await execute({ from_path: '/many.ts', to_path: '/renamed.ts' }, createMockSendEvent(), context());

		expect(result.metadata.diagnostics).toHaveLength(20);
		expect(result.output).toContain('Showing 20 of 25 diagnostics');
	});

	it('returns empty diagnostics array for clean files', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/clean.ts`, 'const x = 1;\n');

		const result = await execute({ from_path: '/clean.ts', to_path: '/moved.ts' }, createMockSendEvent(), context());

		expect(result.metadata.diagnostics).toEqual([]);
	});
});
