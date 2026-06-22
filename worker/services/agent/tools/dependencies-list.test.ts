import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const memoryFs = createMemoryFs();

vi.mock('@worker/lib/project-fs', () => memoryFs.asMock());

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

	it('returns dependencies from package.json', async () => {
		const packageJson = {
			name: 'test-project',
			dependencies: { react: '^18.0.0', hono: '^4.0.0', zod: '*' },
		};
		memoryFs.seedFile(`${PROJECT_ROOT}/package.json`, JSON.stringify(packageJson));

		const result = await execute({}, createMockSendEvent(), context());

		expect(result.metadata).toHaveProperty('dependencies');
		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(dependencies).toHaveProperty('react', '^18.0.0');
		expect(dependencies).toHaveProperty('hono', '^4.0.0');
		expect(dependencies).toHaveProperty('zod', '*');
	});

	// ── No dependencies field ─────────────────────────────────────────────

	it('returns empty dependencies when field is missing', async () => {
		const packageJson = { name: 'test-project', type: 'module' };
		memoryFs.seedFile(`${PROJECT_ROOT}/package.json`, JSON.stringify(packageJson));

		const result = await execute({}, createMockSendEvent(), context());

		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(Object.keys(dependencies)).toHaveLength(0);
	});

	// ── No meta file ──────────────────────────────────────────────────────

	it('returns empty dependencies with note when no files exist', async () => {
		const result = await execute({}, createMockSendEvent(), context());

		expect(result.metadata).toHaveProperty('dependencies');
		expect(result.output).toContain('No dependencies registered');
	});
});
