/**
 * Integration tests for the file_delete tool.
 *
 * Tests file deletion, protected file guards, path validation,
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

const { execute } = await import('./file-delete');

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

describe('file_delete', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Successful deletion ───────────────────────────────────────────────

	it('deletes an existing file and returns line count and byte size', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/temp.ts`, 'line1\nline2\nline3\n');

		const result = await execute({ path: '/temp.ts' }, createMockSendEvent(), context());

		expect(result).toHaveProperty('result');
		const resultObject = result as { result: string };
		expect(resultObject.result).toContain('Deleted /temp.ts');
		expect(resultObject.result).toMatch(/\d+ lines/);
		expect(resultObject.result).toMatch(/\d+ bytes/);
		expect(memoryFs.store.has(`${PROJECT_ROOT}/temp.ts`)).toBe(false);
	});

	it('sends file_changed event with action=delete', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/gone.ts`, 'bye');
		const sendEvent = createMockSendEvent();

		await execute({ path: '/gone.ts' }, sendEvent, context());

		const fileChangedEvent = sendEvent.calls.find(([type]) => type === 'file_changed');
		expect(fileChangedEvent).toBeDefined();
		expect(fileChangedEvent![1]).toHaveProperty('action', 'delete');
		expect(fileChangedEvent![1]).toHaveProperty('path', '/gone.ts');
	});

	// ── Snapshot tracking ─────────────────────────────────────────────────

	it('tracks deletion in queryChanges', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/tracked.ts`, 'content before delete');
		const queryChanges: FileChange[] = [];

		await execute({ path: '/tracked.ts' }, createMockSendEvent(), context(), 'tool-789', queryChanges);

		expect(queryChanges).toHaveLength(1);
		expect(queryChanges[0].action).toBe('delete');
		expect(queryChanges[0].beforeContent).toBe('content before delete');
	});

	// ── Error cases ───────────────────────────────────────────────────────

	it('returns FILE_NOT_FOUND for missing file', async () => {
		await expect(execute({ path: '/nonexistent.ts' }, createMockSendEvent(), context())).rejects.toThrow('[FILE_NOT_FOUND]');
	});

	it('rejects path traversal', async () => {
		await expect(execute({ path: '/../escape.ts' }, createMockSendEvent(), context())).rejects.toThrow('[INVALID_PATH]');
	});

	it('rejects hidden paths', async () => {
		await expect(execute({ path: '/.agent/secret.json' }, createMockSendEvent(), context())).rejects.toThrow('[INVALID_PATH]');
	});

	it('rejects protected files', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/index.html`, '<html></html>');

		await expect(execute({ path: '/index.html' }, createMockSendEvent(), context())).rejects.toThrow('[NOT_ALLOWED]');
	});

	it('rejects deleting protected file /package.json', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/package.json`, '{}');

		await expect(execute({ path: '/package.json' }, createMockSendEvent(), context())).rejects.toThrow('[NOT_ALLOWED]');
	});

	it('rejects deleting parent directory of protected file', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/worker/index.ts`, 'export default {}');

		await expect(execute({ path: '/worker' }, createMockSendEvent(), context())).rejects.toThrow('[NOT_ALLOWED]');
	});
});
