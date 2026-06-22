import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const memoryFs = createMemoryFs();

vi.mock('@worker/lib/project-fs', () => memoryFs.asMock());

const mockTriggerUpdate = vi.fn(async () => {});
vi.mock('../../../lib/durable-object-namespaces', () => ({
	coordinatorNamespace: {
		getByName: () => ({ triggerUpdate: mockTriggerUpdate }),
	},
}));

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

function seedPackageJson(dependencies: Record<string, string> = {}) {
	const packageJson = { name: 'test', type: 'module', dependencies };
	memoryFs.seedFile(`${PROJECT_ROOT}/package.json`, JSON.stringify(packageJson));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dependencies_update', () => {
	beforeEach(() => {
		memoryFs.reset();
		mockTriggerUpdate.mockClear();
	});

	// ── Add ───────────────────────────────────────────────────────────────

	it('adds a new dependency with specified version', async () => {
		seedPackageJson({});

		const result = await execute({ action: 'add', name: 'hono', version: '^4.0.0' }, createMockSendEvent(), context());

		expect(result.metadata).toHaveProperty('action', 'add');
		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(dependencies).toHaveProperty('hono', '^4.0.0');
	});

	it('adds a dependency with default * version when no version specified', async () => {
		seedPackageJson({});

		const result = await execute({ action: 'add', name: 'lodash' }, createMockSendEvent(), context());

		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(dependencies).toHaveProperty('lodash', '*');
	});

	it('rejects adding a duplicate dependency', async () => {
		seedPackageJson({ react: '^18.0.0' });

		await expect(execute({ action: 'add', name: 'react' }, createMockSendEvent(), context())).rejects.toThrow('already exists');
	});

	// ── Remove ────────────────────────────────────────────────────────────

	it('removes an existing dependency', async () => {
		seedPackageJson({ react: '^18.0.0', hono: '^4.0.0' });

		const result = await execute({ action: 'remove', name: 'react' }, createMockSendEvent(), context());

		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(dependencies).not.toHaveProperty('react');
		expect(dependencies).toHaveProperty('hono');
	});

	it('rejects removing a non-existent dependency', async () => {
		seedPackageJson({ react: '^18.0.0' });

		await expect(execute({ action: 'remove', name: 'nonexistent' }, createMockSendEvent(), context())).rejects.toThrow('not registered');
	});

	// ── Update ────────────────────────────────────────────────────────────

	it('updates version of an existing dependency', async () => {
		seedPackageJson({ react: '^17.0.0' });

		const result = await execute({ action: 'update', name: 'react', version: '^18.0.0' }, createMockSendEvent(), context());

		const { dependencies } = result.metadata as { dependencies: Record<string, string> };
		expect(dependencies).toHaveProperty('react', '^18.0.0');
	});

	it('rejects updating a non-existent dependency', async () => {
		seedPackageJson({});

		await expect(execute({ action: 'update', name: 'missing', version: '^1.0.0' }, createMockSendEvent(), context())).rejects.toThrow(
			'not registered',
		);
	});

	// ── Edge cases ────────────────────────────────────────────────────────

	it('returns error when no package.json exists', async () => {
		await expect(execute({ action: 'add', name: 'hono' }, createMockSendEvent(), context())).rejects.toThrow('No package.json');
	});

	it('returns error for missing package name', async () => {
		seedPackageJson({});

		await expect(execute({ action: 'add', name: '' }, createMockSendEvent(), context())).rejects.toThrow('name is required');
	});

	it('returns error for unknown action', async () => {
		seedPackageJson({});

		await expect(execute({ action: 'invalid_action', name: 'pkg' }, createMockSendEvent(), context())).rejects.toThrow('Unknown action');
	});

	// ── Persistence ───────────────────────────────────────────────────────

	it('persists updated dependencies to package.json', async () => {
		seedPackageJson({ existing: '1.0.0' });

		await execute({ action: 'add', name: 'new-pkg', version: '2.0.0' }, createMockSendEvent(), context());

		const entry = memoryFs.store.get(`${PROJECT_ROOT}/package.json`);
		expect(entry).toBeDefined();
		const packageJson = JSON.parse(entry!.content as string);
		expect(packageJson.dependencies).toHaveProperty('existing', '1.0.0');
		expect(packageJson.dependencies).toHaveProperty('new-pkg', '2.0.0');
	});

	// ── Coordinator notification ───────────────────────────────────────────

	it('triggers a full-reload coordinator update after adding a dependency', async () => {
		seedPackageJson({});

		await execute({ action: 'add', name: 'hono', version: '^4.0.0' }, createMockSendEvent(), context());

		expect(mockTriggerUpdate).toHaveBeenCalledOnce();
		expect(mockTriggerUpdate).toHaveBeenCalledWith(expect.objectContaining({ type: 'full-reload', path: '/package.json' }));
	});

	it('triggers a full-reload coordinator update after removing a dependency', async () => {
		seedPackageJson({ react: '^18.0.0' });

		await execute({ action: 'remove', name: 'react' }, createMockSendEvent(), context());

		expect(mockTriggerUpdate).toHaveBeenCalledOnce();
		expect(mockTriggerUpdate).toHaveBeenCalledWith(expect.objectContaining({ type: 'full-reload', path: '/package.json' }));
	});

	it('triggers a full-reload coordinator update after updating a dependency', async () => {
		seedPackageJson({ react: '^17.0.0' });

		await execute({ action: 'update', name: 'react', version: '^18.0.0' }, createMockSendEvent(), context());

		expect(mockTriggerUpdate).toHaveBeenCalledOnce();
		expect(mockTriggerUpdate).toHaveBeenCalledWith(expect.objectContaining({ type: 'full-reload', path: '/package.json' }));
	});

	it('does not trigger coordinator update when action fails', async () => {
		seedPackageJson({});

		await expect(execute({ action: 'remove', name: 'nonexistent' }, createMockSendEvent(), context())).rejects.toThrow();

		expect(mockTriggerUpdate).not.toHaveBeenCalled();
	});
});
