/**
 * Integration tests for the file_glob tool.
 *
 * Tests real minimatch glob matching, subdirectory scoping,
 * brace expansion, and result capping against an in-memory filesystem.
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

const { execute } = await import('./file-glob');

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

describe('file_glob', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Basic matching ────────────────────────────────────────────────────

	it('matches files by extension', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/app.ts`, 'app');
		memoryFs.seedFile(`${PROJECT_ROOT}/src/style.css`, 'css');
		memoryFs.seedFile(`${PROJECT_ROOT}/src/utils.ts`, 'utils');

		const result = await execute({ pattern: '**/*.ts' }, createMockSendEvent(), context());

		expect(result).toContain('/src/app.ts');
		expect(result).toContain('/src/utils.ts');
		expect(result).not.toContain('style.css');
	});

	it('supports brace expansion patterns', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/file.ts`, 'ts');
		memoryFs.seedFile(`${PROJECT_ROOT}/file.tsx`, 'tsx');
		memoryFs.seedFile(`${PROJECT_ROOT}/file.js`, 'js');
		memoryFs.seedFile(`${PROJECT_ROOT}/file.css`, 'css');

		const result = await execute({ pattern: '*.{ts,tsx}' }, createMockSendEvent(), context());

		expect(result).toContain('file.ts');
		expect(result).toContain('file.tsx');
		expect(result).not.toContain('file.js');
		expect(result).not.toContain('file.css');
	});

	// ── Subdirectory scoping ──────────────────────────────────────────────

	it('scopes search to a specific path', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/app.ts`, 'app');
		memoryFs.seedFile(`${PROJECT_ROOT}/test/app.test.ts`, 'test');

		const result = await execute({ pattern: '**/*.ts', path: '/src' }, createMockSendEvent(), context());

		expect(result).toContain('app.ts');
		expect(result).not.toContain('test');
	});

	// ── No results ────────────────────────────────────────────────────────

	it('returns "No files found" when nothing matches', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/file.ts`, 'content');

		const result = await execute({ pattern: '**/*.py' }, createMockSendEvent(), context());

		expect(result).toBe('No files found');
	});

	// ── Deep nesting ──────────────────────────────────────────────────────

	it('matches deeply nested files', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/a/b/c/d/deep.ts`, 'deep');

		const result = await execute({ pattern: '**/*.ts' }, createMockSendEvent(), context());

		expect(result).toContain('/a/b/c/d/deep.ts');
	});

	// ── Dot files ─────────────────────────────────────────────────────────

	it('matches dot files when pattern requests them', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/.eslintrc.json`, '{}');
		memoryFs.seedFile(`${PROJECT_ROOT}/tsconfig.json`, '{}');

		const result = await execute({ pattern: '*.json' }, createMockSendEvent(), context());

		// .eslintrc.json should match due to dot: true option
		expect(result).toContain('.eslintrc.json');
		expect(result).toContain('tsconfig.json');
	});
});
