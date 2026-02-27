/**
 * Integration tests for the file_write tool.
 *
 * Tests file creation, overwrite-with-read-guard, path validation,
 * diff stats, and snapshot tracking against an in-memory filesystem.
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

const { execute } = await import('./file-write');

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

describe('file_write', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Creating new files ────────────────────────────────────────────────

	it('creates a new file and returns diff stats', async () => {
		const result = await execute({ path: '/src/new-file.ts', content: 'export const a = 1;\n' }, createMockSendEvent(), context());

		expect(result).toHaveProperty('output');
		expect(result.metadata).toHaveProperty('linesAdded');
		// File should exist in the memory fs
		expect(memoryFs.store.has(`${PROJECT_ROOT}/src/new-file.ts`)).toBe(true);
	});

	it('sends file_changed event for new files with action=create', async () => {
		const sendEvent = createMockSendEvent();

		await execute({ path: '/new.ts', content: 'hello' }, sendEvent, context());

		const fileChangedEvent = sendEvent.calls.find(([type]) => type === 'file_changed');
		expect(fileChangedEvent).toBeDefined();
		expect(fileChangedEvent![1]).toHaveProperty('action', 'create');
		expect(fileChangedEvent![1]).toHaveProperty('path', '/new.ts');
	});

	// ── Overwriting existing files ────────────────────────────────────────

	it('overwrites an existing file after it was read', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/existing.ts`, 'old content');
		// Simulate that the file was read (record in file-time)
		const { recordFileRead } = await import('../file-time');
		await recordFileRead(PROJECT_ROOT, 'test-session', '/existing.ts');

		const result = await execute({ path: '/existing.ts', content: 'new content' }, createMockSendEvent(), context());

		expect(result).toHaveProperty('output');
		const entry = memoryFs.store.get(`${PROJECT_ROOT}/existing.ts`);
		expect(entry?.content).toBe('new content');
	});

	it('returns FILE_NOT_READ error when overwriting without reading first', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/unread.ts`, 'original');

		await expect(execute({ path: '/unread.ts', content: 'overwritten' }, createMockSendEvent(), context())).rejects.toThrow(
			'[FILE_NOT_READ]',
		);
	});

	it('skips write when content is identical', async () => {
		const content = 'identical content';
		memoryFs.seedFile(`${PROJECT_ROOT}/same.ts`, content);
		const { recordFileRead } = await import('../file-time');
		await recordFileRead(PROJECT_ROOT, 'test-session', '/same.ts');

		const result = await execute({ path: '/same.ts', content }, createMockSendEvent(), context());

		expect(result.output).toBe('No changes needed — the file already contains the expected content.');
	});

	// ── Snapshot tracking ─────────────────────────────────────────────────

	it('tracks file change in queryChanges array', async () => {
		const queryChanges: FileChange[] = [];

		const result = await execute({ path: '/tracked.ts', content: 'tracked content' }, createMockSendEvent(), context(), queryChanges);

		expect(result).toHaveProperty('output');
		expect(queryChanges).toHaveLength(1);
		expect(queryChanges[0].path).toBe('/tracked.ts');
		expect(queryChanges[0].action).toBe('create');
		expect(queryChanges[0].afterContent).toBe('tracked content');
	});

	// ── Error cases ───────────────────────────────────────────────────────

	it('rejects path traversal', async () => {
		await expect(execute({ path: '/../escape.ts', content: 'bad' }, createMockSendEvent(), context())).rejects.toThrow('[INVALID_PATH]');
	});

	it('rejects hidden paths', async () => {
		await expect(execute({ path: '/.agent/secret.json', content: '{}' }, createMockSendEvent(), context())).rejects.toThrow(
			'[INVALID_PATH]',
		);
	});

	it('rejects direct /package.json creation', async () => {
		await expect(execute({ path: '/package.json', content: '{}' }, createMockSendEvent(), context())).rejects.toThrow('[NOT_ALLOWED]');
	});

	// ── CSS file triggers update instead of full-reload ───────────────────

	it('sends file_changed event for overwrite with action=edit', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/style.css`, 'body {}');
		const { recordFileRead } = await import('../file-time');
		await recordFileRead(PROJECT_ROOT, 'test-session', '/style.css');

		const sendEvent = createMockSendEvent();
		await execute({ path: '/style.css', content: 'body { color: red; }' }, sendEvent, context());

		const fileChangedEvent = sendEvent.calls.find(([type]) => type === 'file_changed');
		expect(fileChangedEvent).toBeDefined();
		expect(fileChangedEvent![1]).toHaveProperty('action', 'edit');
	});
});
