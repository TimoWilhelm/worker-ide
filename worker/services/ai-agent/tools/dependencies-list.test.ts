/**
 * Integration tests for the dependencies_list tool.
 *
 * Tests reading project metadata and returning the dependency map.
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

const { execute } = await import('./dependencies-list');

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

describe('dependencies_list', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── With dependencies ─────────────────────────────────────────────────

	it('returns dependencies from .project-meta.json', async () => {
		const meta = {
			name: 'test-project',
			humanId: 'test-123',
			dependencies: { react: '^18.0.0', hono: '^4.0.0', zod: '*' },
		};
		memoryFs.seedFile(`${PROJECT_ROOT}/.project-meta.json`, JSON.stringify(meta));

		const result = await execute({}, createMockSendEvent(), context());

		expect(result.metadata).toHaveProperty('dependencies');
		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(dependencies).toHaveProperty('react', '^18.0.0');
		expect(dependencies).toHaveProperty('hono', '^4.0.0');
		expect(dependencies).toHaveProperty('zod', '*');
	});

	// ── No dependencies field ─────────────────────────────────────────────

	it('returns empty dependencies when field is missing', async () => {
		const meta = { name: 'test-project', humanId: 'test-123' };
		memoryFs.seedFile(`${PROJECT_ROOT}/.project-meta.json`, JSON.stringify(meta));

		const result = await execute({}, createMockSendEvent(), context());

		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(Object.keys(dependencies)).toHaveLength(0);
	});

	// ── No meta file ──────────────────────────────────────────────────────

	it('returns empty dependencies with note when meta file is missing', async () => {
		const result = await execute({}, createMockSendEvent(), context());

		expect(result.metadata).toHaveProperty('dependencies');
		expect(result.output).toContain('No project metadata');
	});
});
