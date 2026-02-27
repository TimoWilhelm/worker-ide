/**
 * Integration tests for the file_edit tool.
 *
 * Tests real string replacement strategies (via replacers.ts), read-before-write
 * enforcement (via file-time.ts), diff stats, and error handling.
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
	lintFileForAgent: async () => [],
	formatLintDiagnostics: () => {},
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./file-edit');

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('file_edit', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Successful edits ──────────────────────────────────────────────────

	it('performs a simple string replacement', async () => {
		await seedAndRead('/src/app.ts', 'const greeting = "hello";\nconsole.log(greeting);\n');

		const result = await execute({ path: '/src/app.ts', old_string: '"hello"', new_string: '"world"' }, createMockSendEvent(), context());

		expect(result).toHaveProperty('output');
		const entry = memoryFs.store.get(`${PROJECT_ROOT}/src/app.ts`);
		expect(entry?.content).toContain('"world"');
		expect(entry?.content).not.toContain('"hello"');
	});

	it('returns diff stats (linesAdded, linesRemoved)', async () => {
		await seedAndRead('/stats.ts', 'line1\nline2\nline3\n');

		const result = await execute(
			{ path: '/stats.ts', old_string: 'line2', new_string: 'replaced\nextra' },
			createMockSendEvent(),
			context(),
		);

		expect(result.metadata).toHaveProperty('linesAdded');
		expect(result.metadata).toHaveProperty('linesRemoved');
	});

	it('replaces all occurrences with replace_all=true', async () => {
		await seedAndRead('/multi.ts', 'foo bar foo baz foo\n');

		const result = await execute(
			{ path: '/multi.ts', old_string: 'foo', new_string: 'qux', replace_all: 'true' },
			createMockSendEvent(),
			context(),
		);

		expect(result).toHaveProperty('output');
		const entry = memoryFs.store.get(`${PROJECT_ROOT}/multi.ts`);
		expect(entry?.content).toBe('qux bar qux baz qux\n');
	});

	it('handles multi-line replacement', async () => {
		const original = 'function hello() {\n  return "hi";\n}\n';
		await seedAndRead('/func.ts', original);

		const result = await execute(
			{
				path: '/func.ts',
				old_string: 'function hello() {\n  return "hi";\n}',
				new_string: 'function hello() {\n  return "hello world";\n}',
			},
			createMockSendEvent(),
			context(),
		);

		expect(result).toHaveProperty('output');
		const entry = memoryFs.store.get(`${PROJECT_ROOT}/func.ts`);
		expect(entry?.content).toContain('"hello world"');
	});

	// ── Snapshot tracking ─────────────────────────────────────────────────

	it('tracks file change in queryChanges', async () => {
		await seedAndRead('/tracked.ts', 'before');
		const queryChanges: FileChange[] = [];

		await execute({ path: '/tracked.ts', old_string: 'before', new_string: 'after' }, createMockSendEvent(), context(), queryChanges);

		expect(queryChanges).toHaveLength(1);
		expect(queryChanges[0].action).toBe('edit');
		expect(queryChanges[0].beforeContent).toBe('before');
		expect(queryChanges[0].afterContent).toBe('after');
	});

	// ── No-change detection ───────────────────────────────────────────────

	it('returns no-change message when replacement produces identical content', async () => {
		await seedAndRead('/same.ts', 'const x = 1;');

		await expect(
			execute({ path: '/same.ts', old_string: 'const x = 1;', new_string: 'const x = 1;' }, createMockSendEvent(), context()),
		).rejects.toThrow('[NO_MATCH]');
	});

	// ── Error cases ───────────────────────────────────────────────────────

	it('returns FILE_NOT_READ when file was not read first', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/unread.ts`, 'content');

		await expect(
			execute({ path: '/unread.ts', old_string: 'content', new_string: 'new' }, createMockSendEvent(), context()),
		).rejects.toThrow('[FILE_NOT_READ]');
	});

	it('returns FILE_NOT_FOUND for missing file', async () => {
		// Record a read so we pass the file-time check, but the file doesn't exist on disk
		const { recordFileRead } = await import('../file-time');
		await recordFileRead(PROJECT_ROOT, 'test-session', '/ghost.ts');

		await expect(execute({ path: '/ghost.ts', old_string: 'x', new_string: 'y' }, createMockSendEvent(), context())).rejects.toThrow(
			'[FILE_NOT_FOUND]',
		);
	});

	it('returns NO_MATCH when old_string is not found', async () => {
		await seedAndRead('/nomatch.ts', 'actual content here');

		await expect(
			execute({ path: '/nomatch.ts', old_string: 'nonexistent string', new_string: 'replacement' }, createMockSendEvent(), context()),
		).rejects.toThrow('[NO_MATCH]');
	});

	it('rejects hidden paths', async () => {
		await expect(
			execute({ path: '/.agent/data.json', old_string: 'a', new_string: 'b' }, createMockSendEvent(), context()),
		).rejects.toThrow('[INVALID_PATH]');
	});

	it('rejects path traversal', async () => {
		await expect(execute({ path: '/../etc/passwd', old_string: 'a', new_string: 'b' }, createMockSendEvent(), context())).rejects.toThrow(
			'[INVALID_PATH]',
		);
	});

	// ── Sends file_changed event ──────────────────────────────────────────

	it('emits file_changed event with before/after content', async () => {
		await seedAndRead('/event.ts', 'old');
		const sendEvent = createMockSendEvent();

		await execute({ path: '/event.ts', old_string: 'old', new_string: 'new' }, sendEvent, context());

		const fileChangedEvent = sendEvent.calls.find(([type]) => type === 'file_changed');
		expect(fileChangedEvent).toBeDefined();
		expect(fileChangedEvent![1]).toHaveProperty('action', 'edit');
		expect(fileChangedEvent![1]).toHaveProperty('beforeContent', 'old');
		expect(fileChangedEvent![1]).toHaveProperty('afterContent', 'new');
	});
});
