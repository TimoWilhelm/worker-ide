/**
 * Tests for the working tree service.
 *
 * Tests the pure functions that don't require the DO filesystem:
 * - computeBlobOid — SHA-1 of git blob format
 * - computeStatus — diff working tree vs committed tree (with mock fs)
 * - collectChanges — gather changed files for commit (with mock fs)
 * - applyTree — checkout (with mock fs)
 */

import { describe, expect, it, vi } from 'vitest';

import { applyTree, collectChanges, computeBlobOid, computeStatus } from './working-tree';

import type { TreeEntry } from '@shared/git-types';

// =============================================================================
// computeBlobOid
// =============================================================================

describe('computeBlobOid', () => {
	it('computes correct git blob OID for empty content', async () => {
		const oid = await computeBlobOid(new Uint8Array(0));
		// "blob 0\0" → well-known SHA-1
		expect(oid).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
	});

	it(String.raw`computes correct git blob OID for "hello world\n"`, async () => {
		const content = new TextEncoder().encode('hello world\n');
		const oid = await computeBlobOid(content);
		// printf 'hello world\n' | git hash-object --stdin
		expect(oid).toBe('3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
	});

	it('returns a 40-character hex string', async () => {
		const content = new TextEncoder().encode('test');
		const oid = await computeBlobOid(content);
		expect(oid).toHaveLength(40);
		expect(oid).toMatch(/^[\da-f]{40}$/);
	});

	it('produces different OIDs for different content', async () => {
		const oid1 = await computeBlobOid(new TextEncoder().encode('hello'));
		const oid2 = await computeBlobOid(new TextEncoder().encode('world'));
		expect(oid1).not.toBe(oid2);
	});

	it('produces same OID for same content', async () => {
		const content = new TextEncoder().encode('deterministic');
		const oid1 = await computeBlobOid(content);
		const oid2 = await computeBlobOid(content);
		expect(oid1).toBe(oid2);
	});
});

// =============================================================================
// Mock filesystem for status/changes/apply tests
// =============================================================================

function createMockFilesystem(files: Record<string, string>) {
	const storage = new Map<string, Uint8Array>();
	for (const [path, content] of Object.entries(files)) {
		storage.set(path, new TextEncoder().encode(content));
	}

	const fileSystem = {
		readdir: vi.fn(async (directory: string, options?: { withFileTypes?: boolean }) => {
			const prefix = directory.endsWith('/') ? directory : `${directory}/`;
			const entries = new Set<string>();

			for (const path of storage.keys()) {
				if (path.startsWith(prefix)) {
					const relative = path.slice(prefix.length);
					const firstPart = relative.split('/')[0];
					entries.add(firstPart);
				}
			}

			if (options?.withFileTypes) {
				return [...entries].map((name) => {
					const fullPath = `${prefix}${name}`;
					const isDirectory = [...storage.keys()].some((key) => key.startsWith(`${fullPath}/`) && key !== fullPath);
					return {
						name,
						isDirectory: () => isDirectory && !storage.has(fullPath),
						isFile: () => storage.has(fullPath),
					};
				});
			}

			return [...entries];
		}),

		readFile: vi.fn(async (path: string) => {
			const content = storage.get(path);
			if (!content) throw new Error(`ENOENT: ${path}`);
			return content;
		}),

		writeFile: vi.fn(async (path: string, content: Uint8Array | string) => {
			const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
			storage.set(path, data);
		}),

		unlink: vi.fn(async (path: string) => {
			if (!storage.delete(path)) throw new Error(`ENOENT: ${path}`);
		}),

		mkdir: vi.fn(async () => {}),
	};

	return { fileSystem, storage };
}

// =============================================================================
// computeStatus
// =============================================================================

describe('computeStatus', () => {
	it('returns empty array when working tree matches committed tree', async () => {
		const content = 'hello world';
		const oid = await computeBlobOid(new TextEncoder().encode(content));

		const { fileSystem } = createMockFilesystem({
			'/project/src/app.ts': content,
		});

		const committedTree: TreeEntry[] = [{ path: 'src/app.ts', oid, mode: 0o10_0644, size: content.length }];

		const status = await computeStatus(fileSystem as never, '/project', committedTree);
		expect(status).toEqual([]);
	});

	it('detects new files as untracked', async () => {
		const { fileSystem } = createMockFilesystem({
			'/project/src/app.ts': 'hello',
			'/project/src/new-file.ts': 'new content',
		});

		const existingOid = await computeBlobOid(new TextEncoder().encode('hello'));
		const committedTree: TreeEntry[] = [{ path: 'src/app.ts', oid: existingOid, mode: 0o10_0644, size: 5 }];

		const status = await computeStatus(fileSystem as never, '/project', committedTree);
		const newFile = status.find((entry) => entry.path === 'src/new-file.ts');

		expect(newFile).toBeDefined();
		expect(newFile!.status).toBe('untracked');
	});

	it('detects modified files', async () => {
		const { fileSystem } = createMockFilesystem({
			'/project/src/app.ts': 'modified content',
		});

		const oldOid = await computeBlobOid(new TextEncoder().encode('original content'));
		const committedTree: TreeEntry[] = [{ path: 'src/app.ts', oid: oldOid, mode: 0o10_0644, size: 16 }];

		const status = await computeStatus(fileSystem as never, '/project', committedTree);
		const modified = status.find((entry) => entry.path === 'src/app.ts');

		expect(modified).toBeDefined();
		expect(modified!.status).toBe('modified');
	});

	it('detects deleted files', async () => {
		const { fileSystem } = createMockFilesystem({});

		const committedTree: TreeEntry[] = [{ path: 'src/deleted.ts', oid: 'abc123'.padEnd(40, '0'), mode: 0o10_0644, size: 10 }];

		const status = await computeStatus(fileSystem as never, '/project', committedTree);
		const deleted = status.find((entry) => entry.path === 'src/deleted.ts');

		expect(deleted).toBeDefined();
		expect(deleted!.status).toBe('deleted');
	});

	it('excludes hidden entries (.initialized, .project-meta.json, .agent, .git)', async () => {
		const { fileSystem } = createMockFilesystem({
			'/project/.initialized': '',
			'/project/.project-meta.json': '{}',
			'/project/src/app.ts': 'hello',
		});

		const oid = await computeBlobOid(new TextEncoder().encode('hello'));
		const committedTree: TreeEntry[] = [{ path: 'src/app.ts', oid, mode: 0o10_0644, size: 5 }];

		const status = await computeStatus(fileSystem as never, '/project', committedTree);
		// Hidden entries should not appear in status
		expect(status.every((entry) => !entry.path.startsWith('.'))).toBe(true);
	});

	it('returns sorted results', async () => {
		const { fileSystem } = createMockFilesystem({
			'/project/z-file.ts': 'z',
			'/project/a-file.ts': 'a',
			'/project/m-file.ts': 'm',
		});

		const status = await computeStatus(fileSystem as never, '/project', []);
		const paths = status.map((entry) => entry.path);
		expect(paths).toEqual([...paths].toSorted());
	});
});

// =============================================================================
// collectChanges
// =============================================================================

describe('collectChanges', () => {
	it('collects all files when committed tree is empty (initial commit)', async () => {
		const { fileSystem } = createMockFilesystem({
			'/project/src/app.ts': 'hello',
			'/project/src/utils.ts': 'export const x = 1;',
		});

		const { files, deletedPaths } = await collectChanges(fileSystem as never, '/project', []);

		expect(files).toHaveLength(2);
		expect(deletedPaths).toHaveLength(0);
		expect(files.map((f) => f.path).toSorted()).toEqual(['src/app.ts', 'src/utils.ts']);
	});

	it('only collects changed files', async () => {
		const unchangedContent = 'unchanged';
		const unchangedOid = await computeBlobOid(new TextEncoder().encode(unchangedContent));

		const { fileSystem } = createMockFilesystem({
			'/project/src/unchanged.ts': unchangedContent,
			'/project/src/changed.ts': 'new content',
		});

		const committedTree: TreeEntry[] = [
			{ path: 'src/unchanged.ts', oid: unchangedOid, mode: 0o10_0644, size: unchangedContent.length },
			{ path: 'src/changed.ts', oid: 'old-oid'.padEnd(40, '0'), mode: 0o10_0644, size: 11 },
		];

		const { files } = await collectChanges(fileSystem as never, '/project', committedTree);

		expect(files).toHaveLength(1);
		expect(files[0].path).toBe('src/changed.ts');
	});

	it('respects staged paths filter', async () => {
		const { fileSystem } = createMockFilesystem({
			'/project/src/staged.ts': 'staged content',
			'/project/src/unstaged.ts': 'unstaged content',
		});

		const { files } = await collectChanges(fileSystem as never, '/project', [], ['src/staged.ts']);

		expect(files).toHaveLength(1);
		expect(files[0].path).toBe('src/staged.ts');
	});

	it('reports deleted paths', async () => {
		const { fileSystem } = createMockFilesystem({
			'/project/src/remaining.ts': 'still here',
		});

		const remainingOid = await computeBlobOid(new TextEncoder().encode('still here'));
		const committedTree: TreeEntry[] = [
			{ path: 'src/remaining.ts', oid: remainingOid, mode: 0o10_0644, size: 10 },
			{ path: 'src/deleted.ts', oid: 'abc'.padEnd(40, '0'), mode: 0o10_0644, size: 10 },
		];

		const { deletedPaths } = await collectChanges(fileSystem as never, '/project', committedTree);

		expect(deletedPaths).toContain('src/deleted.ts');
	});
});

// =============================================================================
// applyTree
// =============================================================================

describe('applyTree', () => {
	it('writes files from the target tree', async () => {
		const { fileSystem } = createMockFilesystem({});

		const content = new TextEncoder().encode('hello world');
		const oid = await computeBlobOid(content);

		const tree: TreeEntry[] = [{ path: 'src/app.ts', oid, mode: 0o10_0644, size: 11 }];

		await applyTree(fileSystem as never, '/project', tree, async (requestedOid) => {
			if (requestedOid === oid) return content;
			return;
		});

		expect(fileSystem.writeFile).toHaveBeenCalled();
	});

	it('deletes files not in the target tree', async () => {
		const { fileSystem } = createMockFilesystem({
			'/project/src/old-file.ts': 'to be deleted',
			'/project/src/app.ts': 'hello',
		});

		const content = new TextEncoder().encode('hello');
		const oid = await computeBlobOid(content);

		const tree: TreeEntry[] = [{ path: 'src/app.ts', oid, mode: 0o10_0644, size: 5 }];

		await applyTree(fileSystem as never, '/project', tree, async (requestedOid) => {
			if (requestedOid === oid) return content;
			return;
		});

		expect(fileSystem.unlink).toHaveBeenCalledWith('/project/src/old-file.ts');
	});

	it('skips unchanged files (matching OIDs)', async () => {
		const content = new TextEncoder().encode('unchanged');
		const oid = await computeBlobOid(content);

		const { fileSystem } = createMockFilesystem({
			'/project/src/app.ts': 'unchanged',
		});

		const tree: TreeEntry[] = [{ path: 'src/app.ts', oid, mode: 0o10_0644, size: 9 }];

		const blobFetcher = vi.fn(async () => content);

		await applyTree(fileSystem as never, '/project', tree, blobFetcher);

		// Blob fetcher should not be called since OIDs match
		expect(blobFetcher).not.toHaveBeenCalled();
	});

	it('creates parent directories for nested files', async () => {
		const { fileSystem } = createMockFilesystem({});

		const content = new TextEncoder().encode('deep');
		const oid = await computeBlobOid(content);

		const tree: TreeEntry[] = [{ path: 'src/features/auth/login.ts', oid, mode: 0o10_0644, size: 4 }];

		await applyTree(fileSystem as never, '/project', tree, async () => content);

		expect(fileSystem.mkdir).toHaveBeenCalled();
	});
});
