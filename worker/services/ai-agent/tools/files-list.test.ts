/**
 * Integration tests for the files_list tool.
 *
 * Tests recursive file listing, hidden directory exclusion,
 * and .initialized filtering against an in-memory filesystem.
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

const { execute } = await import('./files-list');

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

describe('files_list', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Basic listing ─────────────────────────────────────────────────────

	it('returns a flat list of all files', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/index.ts`, 'index');
		memoryFs.seedFile(`${PROJECT_ROOT}/src/app.ts`, 'app');
		memoryFs.seedFile(`${PROJECT_ROOT}/src/utils/helper.ts`, 'helper');

		const result = await execute({}, createMockSendEvent(), context());

		const files = result.output.split('\n');
		expect(files).toContain('/index.ts');
		expect(files).toContain('/src/app.ts');
		expect(files).toContain('/src/utils/helper.ts');
		expect(result.metadata.count).toBe(3);
	});

	// ── Hidden directories excluded ───────────────────────────────────────

	it('excludes files inside hidden directories', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/visible.ts`, 'x');
		memoryFs.seedFile(`${PROJECT_ROOT}/.agent/config.json`, '{}');
		memoryFs.seedFile(`${PROJECT_ROOT}/.git/HEAD`, 'ref');

		const result = await execute({}, createMockSendEvent(), context());

		const files = result.output.split('\n');
		expect(files).toContain('/visible.ts');
		expect(files.some((f) => f.includes('.agent'))).toBe(false);
		expect(files.some((f) => f.includes('.git'))).toBe(false);
	});

	// ── .initialized filtered ─────────────────────────────────────────────

	it('filters out .initialized files', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/.initialized`, '1');
		memoryFs.seedFile(`${PROJECT_ROOT}/real.ts`, 'content');

		const result = await execute({}, createMockSendEvent(), context());

		const files = result.output.split('\n');
		expect(files).not.toContain('/.initialized');
		expect(files).toContain('/real.ts');
	});

	// ── Empty project ─────────────────────────────────────────────────────

	it('returns empty array for empty project', async () => {
		memoryFs.seedDirectory(PROJECT_ROOT);

		const result = await execute({}, createMockSendEvent(), context());

		expect(result.metadata.count).toBe(0);
		expect(result.output).toBe('');
	});
});
