/**
 * Integration tests for the file_list tool.
 *
 * Tests directory listing with type/size info, pattern filtering,
 * hidden entry exclusion, and error handling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const memoryFs = createMemoryFs();

vi.mock('node:fs/promises', () => memoryFs.asMock());

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./file-list');

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

describe('file_list', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Basic listing ─────────────────────────────────────────────────────

	it('lists files and directories with type information', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/file.ts`, 'content');
		memoryFs.seedFile(`${PROJECT_ROOT}/src/app.ts`, 'app');

		const result = await execute({ path: '/' }, createMockSendEvent(), context());

		expect(result.title).toBe('/');
		const entries = result.metadata.entries as Array<{ name: string; type: string }>;
		const fileEntry = entries.find((entry) => entry.name === 'file.ts');
		const directoryEntry = entries.find((entry) => entry.name === 'src');
		expect(fileEntry?.type).toBe('file');
		expect(directoryEntry?.type).toBe('directory');
	});

	it('includes file sizes', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/sized.ts`, 'hello world');

		const result = await execute({ path: '/' }, createMockSendEvent(), context());

		const entries = result.metadata.entries as Array<{ name: string; size?: number }>;
		const entry = entries.find((entry) => entry.name === 'sized.ts');
		expect(entry?.size).toBeGreaterThan(0);
	});

	// ── Hidden entry filtering ────────────────────────────────────────────

	it('excludes hidden entries', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/.agent/config.json`, '{}');
		memoryFs.seedFile(`${PROJECT_ROOT}/.initialized`, '1');
		memoryFs.seedFile(`${PROJECT_ROOT}/visible.ts`, 'x');

		const result = await execute({ path: '/' }, createMockSendEvent(), context());

		const entries = result.metadata.entries as Array<{ name: string }>;
		const names = entries.map((entry) => entry.name);
		expect(names).toContain('visible.ts');
		expect(names).not.toContain('.agent');
		expect(names).not.toContain('.initialized');
	});

	// ── Pattern filtering ─────────────────────────────────────────────────

	it('filters entries by glob pattern', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/app.ts`, 'ts');
		memoryFs.seedFile(`${PROJECT_ROOT}/style.css`, 'css');
		memoryFs.seedFile(`${PROJECT_ROOT}/index.ts`, 'ts');

		const result = await execute({ path: '/', pattern: '*.ts' }, createMockSendEvent(), context());

		const entries = result.metadata.entries as Array<{ name: string }>;
		const names = entries.map((entry) => entry.name);
		expect(names).toContain('app.ts');
		expect(names).toContain('index.ts');
		expect(names).not.toContain('style.css');
	});

	// ── Defaults ──────────────────────────────────────────────────────────

	it('defaults to root when no path is given', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/root-file.ts`, 'x');

		const result = await execute({}, createMockSendEvent(), context());

		expect(result.title).toBe('/');
		const entries = result.metadata.entries as Array<{ name: string }>;
		expect(entries.some((entry) => entry.name === 'root-file.ts')).toBe(true);
	});

	// ── Error case ────────────────────────────────────────────────────────

	it('throws for non-existent directory', async () => {
		await expect(execute({ path: '/nonexistent' }, createMockSendEvent(), context())).rejects.toThrow('Directory not found');
	});
});
