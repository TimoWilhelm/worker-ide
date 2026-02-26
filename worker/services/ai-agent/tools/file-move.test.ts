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
});
