import git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';

import { createInMemoryProjectFs } from './test-workspace';

describe('WorkspaceFsAdapter', () => {
	it('reads and writes text and bytes', async () => {
		const { adapter } = createInMemoryProjectFs();
		await adapter.writeFile('/a/b.txt', 'hello');
		expect(await adapter.readFile('/a/b.txt', 'utf8')).toBe('hello');
		const buffer = await adapter.readFile('/a/b.txt');
		expect(buffer.toString('utf8')).toBe('hello');
	});

	it('readdir returns names or Dirent entries', async () => {
		const { adapter } = createInMemoryProjectFs();
		await adapter.writeFile('/dir/file.ts', 'x');
		await adapter.mkdir('/dir/sub', { recursive: true });

		const names = await adapter.readdir('/dir');
		expect(names.toSorted()).toEqual(['file.ts', 'sub']);

		const entries = await adapter.readdir('/dir', { withFileTypes: true });
		const file = entries.find((entry) => entry.name === 'file.ts');
		const sub = entries.find((entry) => entry.name === 'sub');
		expect(file?.isFile()).toBe(true);
		expect(sub?.isDirectory()).toBe(true);
	});

	it('stat throws ENOENT for missing paths and reports type', async () => {
		const { adapter } = createInMemoryProjectFs();
		await adapter.writeFile('/x.txt', 'y');
		const stats = await adapter.stat('/x.txt');
		expect(stats.isFile()).toBe(true);
		await expect(adapter.access('/nope')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('normalizes Workspace mkdir errors to Node errno errors', async () => {
		const { adapter } = createInMemoryProjectFs();
		await expect(adapter.mkdir('/missing/child')).rejects.toMatchObject({ code: 'ENOENT' });

		await adapter.mkdir('/existing');
		await expect(adapter.mkdir('/existing')).rejects.toMatchObject({ code: 'EEXIST' });
	});

	it('rename, unlink and rm work', async () => {
		const { adapter } = createInMemoryProjectFs();
		await adapter.writeFile('/old.txt', 'data');
		await adapter.rename('/old.txt', '/new.txt');
		expect(await adapter.readFile('/new.txt', 'utf8')).toBe('data');
		await adapter.unlink('/new.txt');
		await expect(adapter.access('/new.txt')).rejects.toMatchObject({ code: 'ENOENT' });
	});
});

describe('isomorphic-git over WorkspaceFsAdapter', () => {
	it('init, add, commit, log and statusMatrix work against the durable fs', async () => {
		const { adapter, workspace } = createInMemoryProjectFs('/project-test');
		const base = { fs: adapter, dir: '/project-test' } as const;

		await git.init({ ...base, defaultBranch: 'main' });
		expect(await workspace.exists('/.git')).toBe(true);
		expect(await workspace.exists('/project-test')).toBe(false);
		await adapter.writeFile('/README.md', '# Hello\n');
		await git.add({ ...base, filepath: 'README.md' });

		const oid = await git.commit({
			...base,
			message: 'initial',
			author: { name: 'Tester', email: 'tester@example.com' },
		});
		expect(oid).toMatch(/^[0-9a-f]{40}$/);

		const log = await git.log({ ...base, ref: 'HEAD', depth: 10 });
		expect(log).toHaveLength(1);
		expect(log[0].commit.message).toContain('initial');

		// Modify the working tree → statusMatrix should report a change.
		await adapter.writeFile('/README.md', '# Hello world\n');
		const matrix = await git.statusMatrix(base);
		const readmeRow = matrix.find((row) => row[0] === 'README.md');
		expect(readmeRow?.[2]).toBe(2); // workdir differs from HEAD
	});
});
