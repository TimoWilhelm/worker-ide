/**
 * Unit tests for the GitClient wrapper.
 *
 * Validates that:
 * - Each method delegates to the correct stub RPC method with the right arguments
 * - The namespace is wrapped with retry logic (cross-worker resilience)
 * - The repo ID convention `ide/{projectId}` is applied correctly
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitClient } from './git-client';

import type { RepoDurableObject } from '../../auxiliary/git/do/repo/repo-do';

function createRetryableError(message: string): Error & { retryable: boolean } {
	return Object.assign(new Error(message), { retryable: true });
}

/**
 * Creates a mock DurableObjectNamespace that tracks calls to idFromName and
 * returns a stub with configurable method implementations.
 */
function createMockNamespace(stubMethods: Record<string, ReturnType<typeof vi.fn>> = {}) {
	const mockStub = {
		id: { toString: () => 'test-stub-id' },
		name: 'test-stub',
		...stubMethods,
	};

	const namespace = {
		get: vi.fn(() => mockStub),
		idFromName: vi.fn((name: string) => ({ toString: () => name })),
		idFromString: vi.fn((id: string) => ({ toString: () => id })),
		newUniqueId: vi.fn(() => ({ toString: () => 'unique-id' })),
		jurisdiction: vi.fn(),
	} as unknown as DurableObjectNamespace<RepoDurableObject>;

	return { namespace, mockStub };
}

afterEach(() => {
	vi.restoreAllMocks();
});

// =============================================================================
// Repo ID convention
// =============================================================================

describe('repo ID convention', () => {
	it('derives repo ID as ide/{projectId}', () => {
		const { namespace } = createMockNamespace();
		new GitClient(namespace, 'my-project');

		expect(namespace.idFromName).toHaveBeenCalledWith('ide/my-project');
	});

	it('handles project IDs with special characters', () => {
		const { namespace } = createMockNamespace();
		new GitClient(namespace, 'project-with-dashes_and_underscores');

		expect(namespace.idFromName).toHaveBeenCalledWith('ide/project-with-dashes_and_underscores');
	});
});

// =============================================================================
// Method delegation
// =============================================================================

describe('method delegation', () => {
	it('delegates commitTree to stub', async () => {
		const commitTree = vi.fn().mockResolvedValue({ oid: 'abc123', ref: 'refs/heads/main' });
		const { namespace } = createMockNamespace({ commitTree });
		const client = new GitClient(namespace, 'test-project');

		const options = { files: [], message: 'test commit', author: { name: 'Test', email: 'test@example.com' } };
		const result = await client.commitTree(options);

		expect(commitTree).toHaveBeenCalledWith(options);
		expect(result).toEqual({ oid: 'abc123', ref: 'refs/heads/main' });
	});

	it('delegates materializeTree to stub', async () => {
		const materializeTree = vi.fn().mockResolvedValue([{ path: 'file.ts', oid: 'abc', mode: '100644', size: 42 }]);
		const { namespace } = createMockNamespace({ materializeTree });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.materializeTree('HEAD');

		expect(materializeTree).toHaveBeenCalledWith('HEAD');
		expect(result).toHaveLength(1);
		expect(result[0].path).toBe('file.ts');
	});

	it('delegates getBlobContent to stub', async () => {
		const content = new Uint8Array([1, 2, 3]);
		const getBlobContent = vi.fn().mockResolvedValue(content);
		const { namespace } = createMockNamespace({ getBlobContent });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.getBlobContent('abc123');

		expect(getBlobContent).toHaveBeenCalledWith('abc123');
		expect(result).toBe(content);
	});

	it('delegates getBlobContentBatch to stub', async () => {
		const batchResult = new Map([['oid1', new Uint8Array([1])]]);
		const getBlobContentBatch = vi.fn().mockResolvedValue(batchResult);
		const { namespace } = createMockNamespace({ getBlobContentBatch });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.getBlobContentBatch(['oid1', 'oid2']);

		expect(getBlobContentBatch).toHaveBeenCalledWith(['oid1', 'oid2']);
		expect(result).toBe(batchResult);
	});

	it('delegates getLog to stub', async () => {
		const logEntries = [{ oid: 'abc', message: 'commit 1', author: 'test', date: '2024-01-01' }];
		const getLog = vi.fn().mockResolvedValue(logEntries);
		const { namespace } = createMockNamespace({ getLog });
		const client = new GitClient(namespace, 'test-project');

		const options = { ref: 'HEAD', depth: 10 };
		const result = await client.getLog(options);

		expect(getLog).toHaveBeenCalledWith(options);
		expect(result).toBe(logEntries);
	});

	it('delegates diffTrees to stub', async () => {
		const diffs = [{ path: 'file.ts', type: 'modify' }];
		const diffTrees = vi.fn().mockResolvedValue(diffs);
		const { namespace } = createMockNamespace({ diffTrees });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.diffTrees('base-ref', 'head-ref');

		expect(diffTrees).toHaveBeenCalledWith('base-ref', 'head-ref');
		expect(result).toBe(diffs);
	});

	it('delegates isAncestor to stub', async () => {
		const isAncestor = vi.fn().mockResolvedValue(true);
		const { namespace } = createMockNamespace({ isAncestor });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.isAncestor('ancestor-oid', 'descendant-ref');

		expect(isAncestor).toHaveBeenCalledWith('ancestor-oid', 'descendant-ref');
		expect(result).toBe(true);
	});

	it('delegates listRefs to stub', async () => {
		const references = [{ name: 'refs/heads/main', oid: 'abc123' }];
		const listReferences = vi.fn().mockResolvedValue(references);
		const { namespace } = createMockNamespace({ listRefs: listReferences });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.listRefs();

		expect(listReferences).toHaveBeenCalled();
		expect(result).toBe(references);
	});

	it('delegates setRefs to stub', async () => {
		const setReferences = vi.fn().mockResolvedValue();
		const { namespace } = createMockNamespace({ setRefs: setReferences });
		const client = new GitClient(namespace, 'test-project');

		const references = [{ name: 'refs/heads/main', oid: 'abc123' }];
		await client.setRefs(references);

		expect(setReferences).toHaveBeenCalledWith(references);
	});

	it('delegates getHead to stub', async () => {
		const head = { target: 'refs/heads/main', oid: 'abc123' };
		const getHead = vi.fn().mockResolvedValue(head);
		const { namespace } = createMockNamespace({ getHead });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.getHead();

		expect(getHead).toHaveBeenCalled();
		expect(result).toEqual(head);
	});

	it('delegates setHead to stub', async () => {
		const setHead = vi.fn().mockResolvedValue();
		const { namespace } = createMockNamespace({ setHead });
		const client = new GitClient(namespace, 'test-project');

		const head = { target: 'refs/heads/main' };
		await client.setHead(head);

		expect(setHead).toHaveBeenCalledWith(head);
	});

	it('delegates getHeadAndRefs to stub', async () => {
		const data = { head: { target: 'refs/heads/main' }, refs: [{ name: 'refs/heads/main', oid: 'abc' }] };
		const getHeadAndReferences = vi.fn().mockResolvedValue(data);
		const { namespace } = createMockNamespace({ getHeadAndRefs: getHeadAndReferences });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.getHeadAndRefs();

		expect(getHeadAndReferences).toHaveBeenCalled();
		expect(result).toEqual(data);
	});

	it('delegates createEphemeralReference to stub', async () => {
		const ephemeral = { name: 'snap/1', oid: 'abc123', createdAt: Date.now() };
		const createEphemeralReference = vi.fn().mockResolvedValue(ephemeral);
		const { namespace } = createMockNamespace({ createEphemeralReference });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.createEphemeralReference('snap/1', 'refs/heads/main');

		expect(createEphemeralReference).toHaveBeenCalledWith('snap/1', 'refs/heads/main');
		expect(result).toBe(ephemeral);
	});

	it('delegates promoteEphemeralReference to stub', async () => {
		const promoteEphemeralReference = vi.fn().mockResolvedValue();
		const { namespace } = createMockNamespace({ promoteEphemeralReference });
		const client = new GitClient(namespace, 'test-project');

		await client.promoteEphemeralReference('snap/1', 'refs/heads/feature');

		expect(promoteEphemeralReference).toHaveBeenCalledWith('snap/1', 'refs/heads/feature');
	});

	it('delegates listEphemeralReferences to stub', async () => {
		const references = [{ name: 'snap/1', oid: 'abc', createdAt: Date.now() }];
		const listEphemeralReferences = vi.fn().mockResolvedValue(references);
		const { namespace } = createMockNamespace({ listEphemeralReferences });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.listEphemeralReferences();

		expect(listEphemeralReferences).toHaveBeenCalled();
		expect(result).toBe(references);
	});

	it('delegates deleteEphemeralReference to stub', async () => {
		const deleteEphemeralReference = vi.fn().mockResolvedValue();
		const { namespace } = createMockNamespace({ deleteEphemeralReference });
		const client = new GitClient(namespace, 'test-project');

		await client.deleteEphemeralReference('snap/1');

		expect(deleteEphemeralReference).toHaveBeenCalledWith('snap/1');
	});

	it('delegates purgeRepo to stub', async () => {
		const purgeRepo = vi.fn().mockResolvedValue({ deletedR2: 5, deletedDO: true });
		const { namespace } = createMockNamespace({ purgeRepo });
		const client = new GitClient(namespace, 'test-project');

		const result = await client.purgeRepo();

		expect(purgeRepo).toHaveBeenCalled();
		expect(result).toEqual({ deletedR2: 5, deletedDO: true });
	});
});

// =============================================================================
// Retry wrapping
// =============================================================================

describe('retry wrapping', () => {
	it('retries on transient infrastructure errors', async () => {
		const listReferences = vi.fn().mockRejectedValueOnce(createRetryableError('transient')).mockResolvedValue([]);

		// Track stub creation count to verify fresh stubs are created on retry
		let stubCreationCount = 0;
		const namespace = {
			get: vi.fn(() => {
				stubCreationCount++;
				return {
					id: { toString: () => 'test-id' },
					name: 'test-stub',
					listRefs: listReferences,
				};
			}),
			idFromName: vi.fn((name: string) => ({ toString: () => name })),
			idFromString: vi.fn(),
			newUniqueId: vi.fn(),
			jurisdiction: vi.fn(),
		} as unknown as DurableObjectNamespace<RepoDurableObject>;

		const client = new GitClient(namespace, 'test-project');
		const result = await client.listRefs();

		expect(result).toEqual([]);
		expect(listReferences).toHaveBeenCalledTimes(2);
		// Fresh stub should be created on retry (initial + 1 retry = 2)
		expect(stubCreationCount).toBe(2);
	});

	it('does not retry non-retryable errors', async () => {
		const listReferences = vi.fn().mockRejectedValue(new Error('fatal'));

		const namespace = {
			get: vi.fn(() => ({
				id: { toString: () => 'test-id' },
				name: 'test-stub',
				listRefs: listReferences,
			})),
			idFromName: vi.fn((name: string) => ({ toString: () => name })),
			idFromString: vi.fn(),
			newUniqueId: vi.fn(),
			jurisdiction: vi.fn(),
		} as unknown as DurableObjectNamespace<RepoDurableObject>;

		const client = new GitClient(namespace, 'test-project');

		await expect(client.listRefs()).rejects.toThrow('fatal');
		expect(listReferences).toHaveBeenCalledTimes(1);
	});
});
