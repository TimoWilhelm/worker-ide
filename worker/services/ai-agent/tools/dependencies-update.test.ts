/**
 * Integration tests for the dependencies_update tool.
 *
 * Tests add/remove/update actions, duplicate detection,
 * and error handling against an in-memory filesystem.
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

const { execute } = await import('./dependencies-update');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT });
}

function seedMeta(dependencies: Record<string, string> = {}) {
	const meta = { name: 'test', humanId: 'id-1', dependencies };
	memoryFs.seedFile(`${PROJECT_ROOT}/.project-meta.json`, JSON.stringify(meta));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dependencies_update', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Add ───────────────────────────────────────────────────────────────

	it('adds a new dependency with specified version', async () => {
		seedMeta({});

		const result = await execute({ action: 'add', name: 'hono', version: '^4.0.0' }, createMockSendEvent(), context());

		expect(result.metadata).toHaveProperty('action', 'add');
		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(dependencies).toHaveProperty('hono', '^4.0.0');
	});

	it('adds a dependency with default * version when no version specified', async () => {
		seedMeta({});

		const result = await execute({ action: 'add', name: 'lodash' }, createMockSendEvent(), context());

		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(dependencies).toHaveProperty('lodash', '*');
	});

	it('rejects adding a duplicate dependency', async () => {
		seedMeta({ react: '^18.0.0' });

		await expect(execute({ action: 'add', name: 'react' }, createMockSendEvent(), context())).rejects.toThrow('already exists');
	});

	// ── Remove ────────────────────────────────────────────────────────────

	it('removes an existing dependency', async () => {
		seedMeta({ react: '^18.0.0', hono: '^4.0.0' });

		const result = await execute({ action: 'remove', name: 'react' }, createMockSendEvent(), context());

		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(dependencies).not.toHaveProperty('react');
		expect(dependencies).toHaveProperty('hono');
	});

	it('rejects removing a non-existent dependency', async () => {
		seedMeta({ react: '^18.0.0' });

		await expect(execute({ action: 'remove', name: 'nonexistent' }, createMockSendEvent(), context())).rejects.toThrow('not registered');
	});

	// ── Update ────────────────────────────────────────────────────────────

	it('updates version of an existing dependency', async () => {
		seedMeta({ react: '^17.0.0' });

		const result = await execute({ action: 'update', name: 'react', version: '^18.0.0' }, createMockSendEvent(), context());

		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(dependencies).toHaveProperty('react', '^18.0.0');
	});

	it('rejects updating a non-existent dependency', async () => {
		seedMeta({});

		await expect(execute({ action: 'update', name: 'missing', version: '^1.0.0' }, createMockSendEvent(), context())).rejects.toThrow(
			'not registered',
		);
	});

	// ── Edge cases ────────────────────────────────────────────────────────

	it('returns error when no project metadata exists', async () => {
		await expect(execute({ action: 'add', name: 'hono' }, createMockSendEvent(), context())).rejects.toThrow('No project metadata');
	});

	it('returns error for missing package name', async () => {
		seedMeta({});

		await expect(execute({ action: 'add', name: '' }, createMockSendEvent(), context())).rejects.toThrow('name is required');
	});

	it('returns error for unknown action', async () => {
		seedMeta({});

		await expect(execute({ action: 'invalid_action', name: 'pkg' }, createMockSendEvent(), context())).rejects.toThrow('Unknown action');
	});

	// ── Persistence ───────────────────────────────────────────────────────

	it('persists updated dependencies to .project-meta.json', async () => {
		seedMeta({ existing: '1.0.0' });

		await execute({ action: 'add', name: 'new-pkg', version: '2.0.0' }, createMockSendEvent(), context());

		const entry = memoryFs.store.get(`${PROJECT_ROOT}/.project-meta.json`);
		expect(entry).toBeDefined();
		const meta = JSON.parse(entry!.content as string);
		expect(meta.dependencies).toHaveProperty('existing', '1.0.0');
		expect(meta.dependencies).toHaveProperty('new-pkg', '2.0.0');
	});
});
