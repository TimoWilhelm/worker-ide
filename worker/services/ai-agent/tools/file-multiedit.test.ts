/**
 * Integration tests for the file_multiedit tool.
 *
 * Tests atomic multi-edit operations, sequential application,
 * error rollback, diff stats, and event emission.
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

vi.mock('../lib/biome-linter', () => ({
	formatLintResultsForAgent: async () => {},
	lintFileForAgent: async () => [],
	formatLintDiagnostics: () => {},
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./file-multiedit');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT });
}

/** Seed a file and record it as read so edits pass the file-time guard. */
async function seedAndRead(path: string, content: string) {
	memoryFs.seedFile(`${PROJECT_ROOT}${path}`, content);
	const { recordFileRead } = await import('../file-time');
	await recordFileRead(PROJECT_ROOT, 'test-session', path);
}

function makeEdits(...edits: Array<{ old_string: string; new_string: string; replace_all?: string }>): string {
	return JSON.stringify(edits);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('file_multiedit', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Successful multi-edits ────────────────────────────────────────────

	it('applies multiple edits to a single file', async () => {
		await seedAndRead('/src/app.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

		const result = await execute(
			{
				path: '/src/app.ts',
				edits: makeEdits(
					{ old_string: 'const a = 1;', new_string: 'const a = 10;' },
					{ old_string: 'const b = 2;', new_string: 'const b = 20;' },
					{ old_string: 'const c = 3;', new_string: 'const c = 30;' },
				),
			},
			createMockSendEvent(),
			context(),
		);

		expect(result).toHaveProperty('output');
		expect(result.metadata).toHaveProperty('editCount', 3);
		const entry = memoryFs.store.get(`${PROJECT_ROOT}/src/app.ts`);
		expect(entry?.content).toBe('const a = 10;\nconst b = 20;\nconst c = 30;\n');
	});

	it('applies edits sequentially — later edits see results of earlier ones', async () => {
		await seedAndRead('/sequential.ts', 'hello world\n');

		const result = await execute(
			{
				path: '/sequential.ts',
				edits: makeEdits({ old_string: 'hello', new_string: 'hi' }, { old_string: 'hi world', new_string: 'hi there' }),
			},
			createMockSendEvent(),
			context(),
		);

		expect(result).toHaveProperty('output');
		const entry = memoryFs.store.get(`${PROJECT_ROOT}/sequential.ts`);
		expect(entry?.content).toBe('hi there\n');
	});

	it('returns diff stats (linesAdded, linesRemoved)', async () => {
		await seedAndRead('/stats.ts', 'line1\nline2\nline3\n');

		const result = await execute(
			{
				path: '/stats.ts',
				edits: makeEdits({ old_string: 'line2', new_string: 'replaced\nextra' }),
			},
			createMockSendEvent(),
			context(),
		);

		expect(result.metadata).toHaveProperty('linesAdded');
		expect(result.metadata).toHaveProperty('linesRemoved');
	});

	it('supports replace_all in individual edits', async () => {
		await seedAndRead('/multi.ts', 'foo bar foo baz foo\n');

		const result = await execute(
			{
				path: '/multi.ts',
				edits: makeEdits({ old_string: 'foo', new_string: 'qux', replace_all: 'true' }),
			},
			createMockSendEvent(),
			context(),
		);

		expect(result).toHaveProperty('output');
		const entry = memoryFs.store.get(`${PROJECT_ROOT}/multi.ts`);
		expect(entry?.content).toBe('qux bar qux baz qux\n');
	});

	// ── No-change detection ───────────────────────────────────────────────

	it('throws when edits produce identical content (old_string === new_string)', async () => {
		await seedAndRead('/same.ts', 'const x = 1;\n');

		await expect(
			execute(
				{
					path: '/same.ts',
					edits: makeEdits({ old_string: 'const x = 1;', new_string: 'const x = 1;' }),
				},
				createMockSendEvent(),
				context(),
			),
		).rejects.toThrow('No changes to apply');
	});

	// ── Snapshot tracking ─────────────────────────────────────────────────

	it('tracks file change in queryChanges', async () => {
		await seedAndRead('/tracked.ts', 'before1 before2');
		const queryChanges: FileChange[] = [];

		await execute(
			{
				path: '/tracked.ts',
				edits: makeEdits({ old_string: 'before1', new_string: 'after1' }, { old_string: 'before2', new_string: 'after2' }),
			},
			createMockSendEvent(),
			context(),
			queryChanges,
		);

		expect(queryChanges).toHaveLength(1);
		expect(queryChanges[0].action).toBe('edit');
		expect(queryChanges[0].beforeContent).toBe('before1 before2');
		expect(queryChanges[0].afterContent).toBe('after1 after2');
	});

	// ── Atomicity: failure rolls back ─────────────────────────────────────

	it('does not write to disk if a later edit fails', async () => {
		await seedAndRead('/atomic.ts', 'alpha beta gamma\n');

		await expect(
			execute(
				{
					path: '/atomic.ts',
					edits: makeEdits(
						{ old_string: 'alpha', new_string: 'ALPHA' }, // succeeds
						{ old_string: 'nonexistent', new_string: 'FAIL' }, // fails
					),
				},
				createMockSendEvent(),
				context(),
			),
		).rejects.toThrow('[NO_MATCH]');

		// File content should be unchanged
		const entry = memoryFs.store.get(`${PROJECT_ROOT}/atomic.ts`);
		expect(entry?.content).toBe('alpha beta gamma\n');
	});

	it('reports which edit failed in the error message', async () => {
		await seedAndRead('/which.ts', 'one two three\n');

		await expect(
			execute(
				{
					path: '/which.ts',
					edits: makeEdits({ old_string: 'one', new_string: 'ONE' }, { old_string: 'missing', new_string: 'FAIL' }),
				},
				createMockSendEvent(),
				context(),
			),
		).rejects.toThrow('Edit 2/2 failed');
	});

	// ── Error cases ───────────────────────────────────────────────────────

	it('rejects invalid edits JSON', async () => {
		await expect(execute({ path: '/any.ts', edits: 'not json' }, createMockSendEvent(), context())).rejects.toThrow('[MISSING_INPUT]');
	});

	it('rejects empty edits array', async () => {
		await expect(execute({ path: '/any.ts', edits: '[]' }, createMockSendEvent(), context())).rejects.toThrow('[MISSING_INPUT]');
	});

	it('rejects edits with missing old_string', async () => {
		await expect(
			execute({ path: '/any.ts', edits: JSON.stringify([{ new_string: 'bar' }]) }, createMockSendEvent(), context()),
		).rejects.toThrow('[MISSING_INPUT]');
	});

	it('returns FILE_NOT_READ when file was not read first', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/unread.ts`, 'content');

		await expect(
			execute(
				{
					path: '/unread.ts',
					edits: makeEdits({ old_string: 'content', new_string: 'new' }),
				},
				createMockSendEvent(),
				context(),
			),
		).rejects.toThrow('[FILE_NOT_READ]');
	});

	it('returns FILE_NOT_FOUND for missing file', async () => {
		const { recordFileRead } = await import('../file-time');
		await recordFileRead(PROJECT_ROOT, 'test-session', '/ghost.ts');

		await expect(
			execute(
				{
					path: '/ghost.ts',
					edits: makeEdits({ old_string: 'x', new_string: 'y' }),
				},
				createMockSendEvent(),
				context(),
			),
		).rejects.toThrow('[FILE_NOT_FOUND]');
	});

	it('rejects hidden paths', async () => {
		await expect(
			execute(
				{
					path: '/.agent/data.json',
					edits: makeEdits({ old_string: 'a', new_string: 'b' }),
				},
				createMockSendEvent(),
				context(),
			),
		).rejects.toThrow('[INVALID_PATH]');
	});

	it('rejects path traversal', async () => {
		await expect(
			execute(
				{
					path: '/../etc/passwd',
					edits: makeEdits({ old_string: 'a', new_string: 'b' }),
				},
				createMockSendEvent(),
				context(),
			),
		).rejects.toThrow('[INVALID_PATH]');
	});

	// ── Events ────────────────────────────────────────────────────────────

	it('emits file_changed event with before/after content', async () => {
		await seedAndRead('/event.ts', 'old1 old2');
		const sendEvent = createMockSendEvent();

		await execute(
			{
				path: '/event.ts',
				edits: makeEdits({ old_string: 'old1', new_string: 'new1' }, { old_string: 'old2', new_string: 'new2' }),
			},
			sendEvent,
			context(),
		);

		const fileChangedEvent = sendEvent.calls.find(([type]) => type === 'file_changed');
		expect(fileChangedEvent).toBeDefined();
		expect(fileChangedEvent![1]).toHaveProperty('action', 'edit');
		expect(fileChangedEvent![1]).toHaveProperty('beforeContent', 'old1 old2');
		expect(fileChangedEvent![1]).toHaveProperty('afterContent', 'new1 new2');
	});

	it('emits a single file_changed event even for multiple edits', async () => {
		await seedAndRead('/single-event.ts', 'a b c');
		const sendEvent = createMockSendEvent();

		await execute(
			{
				path: '/single-event.ts',
				edits: makeEdits({ old_string: 'a', new_string: 'A' }, { old_string: 'b', new_string: 'B' }, { old_string: 'c', new_string: 'C' }),
			},
			sendEvent,
			context(),
		);

		const fileChangedEvents = sendEvent.calls.filter(([type]) => type === 'file_changed');
		expect(fileChangedEvents).toHaveLength(1);
	});
});
