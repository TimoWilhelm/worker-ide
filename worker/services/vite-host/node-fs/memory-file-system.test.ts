import { describe, expect, it } from 'vitest';

import { FileSystemError, MemoryFileSystem, normalizePosixPath } from './memory-file-system';

describe('normalizePosixPath', () => {
	it('collapses . and .. segments', () => {
		expect(normalizePosixPath('/a/./b/../c')).toBe('/a/c');
		expect(normalizePosixPath('/a/b/../../c')).toBe('/c');
		expect(normalizePosixPath('a/b')).toBe('/a/b');
		expect(normalizePosixPath('/')).toBe('/');
	});
});

describe('MemoryFileSystem read/write', () => {
	it('writes and reads files, creating parent directories', () => {
		const fs = new MemoryFileSystem();
		fs.writeFile('/app/page.tsx', 'export default () => null;');
		expect(fs.exists('/app/page.tsx')).toBe(true);
		expect(fs.exists('/app')).toBe(true);
		expect(fs.readFileText('/app/page.tsx')).toBe('export default () => null;');
	});

	it('throws ENOENT for missing files', () => {
		const fs = new MemoryFileSystem();
		expect(() => fs.readFileText('/missing.ts')).toThrowError(FileSystemError);
		try {
			fs.readFileText('/missing.ts');
		} catch (error) {
			expect(error).toBeInstanceOf(FileSystemError);
			expect((error as FileSystemError).code).toBe('ENOENT');
		}
	});

	it('round-trips through a snapshot', () => {
		const fs = MemoryFileSystem.fromSnapshot({
			'/app/page.tsx': 'page',
			'/app/layout.tsx': 'layout',
			'next.config.js': 'module.exports = {};',
		});
		const snapshot = fs.toSnapshot();
		expect(snapshot['/app/page.tsx']).toBe('page');
		expect(snapshot['/next.config.js']).toBe('module.exports = {};');
	});
});

describe('MemoryFileSystem.readdir', () => {
	it('lists immediate children with file/dir types', () => {
		const fs = MemoryFileSystem.fromSnapshot({
			'/app/page.tsx': 'p',
			'/app/blog/page.tsx': 'b',
			'/app/layout.tsx': 'l',
		});
		const entries = fs.readdir('/app');
		const names = entries.map((entry) => entry.name).toSorted();
		expect(names).toEqual(['blog', 'layout.tsx', 'page.tsx']);
		const blog = entries.find((entry) => entry.name === 'blog');
		expect(blog?.isDirectory()).toBe(true);
		const page = entries.find((entry) => entry.name === 'page.tsx');
		expect(page?.isFile()).toBe(true);
	});

	it('throws ENOTDIR when reading a file as a directory', () => {
		const fs = MemoryFileSystem.fromSnapshot({ '/a.txt': 'x' });
		try {
			fs.readdir('/a.txt');
			expect.unreachable();
		} catch (error) {
			expect((error as FileSystemError).code).toBe('ENOTDIR');
		}
	});
});

describe('MemoryFileSystem stat / mkdir / remove / copy', () => {
	it('reports stats', () => {
		const fs = MemoryFileSystem.fromSnapshot({ '/a.txt': 'hello' });
		const stats = fs.stat('/a.txt');
		expect(stats.isFile()).toBe(true);
		expect(stats.size).toBe(5);
		expect(fs.stat('/').isDirectory()).toBe(true);
	});

	it('mkdir recursive creates nested directories', () => {
		const fs = new MemoryFileSystem();
		fs.mkdir('/a/b/c', { recursive: true });
		expect(fs.stat('/a/b/c').isDirectory()).toBe(true);
	});

	it('removes files and subtrees recursively', () => {
		const fs = MemoryFileSystem.fromSnapshot({ '/d/a.txt': 'a', '/d/sub/b.txt': 'b' });
		fs.remove('/d', { recursive: true });
		expect(fs.exists('/d')).toBe(false);
		expect(fs.exists('/d/sub/b.txt')).toBe(false);
	});

	it('copies a directory subtree', () => {
		const fs = MemoryFileSystem.fromSnapshot({ '/src/a.txt': 'a', '/src/sub/b.txt': 'b' });
		fs.copy('/src', '/dst');
		expect(fs.readFileText('/dst/a.txt')).toBe('a');
		expect(fs.readFileText('/dst/sub/b.txt')).toBe('b');
	});
});
