import { describe, expect, it } from 'vitest';

import { FileSystemError, MemoryFileSystem, normalizePosixPath, VendoredLayer } from './memory-file-system';

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

function withVendored(): MemoryFileSystem {
	const fs = new MemoryFileSystem();
	fs.addBaseLayer(
		VendoredLayer.fromRecord(
			{
				'node_modules/react/package.json': '{"name":"react"}',
				'node_modules/react/index.js': 'module.exports = {};',
			},
			'/',
		),
	);
	return fs;
}

describe('MemoryFileSystem read-through base layer', () => {
	it('reads files and directories through the base layer without copying them', () => {
		const fs = withVendored();
		expect(fs.exists('/node_modules/react/index.js')).toBe(true);
		expect(fs.exists('/node_modules/react')).toBe(true);
		expect(fs.exists('/node_modules')).toBe(true);
		expect(fs.readFileText('/node_modules/react/package.json')).toBe('{"name":"react"}');
		expect(fs.stat('/node_modules/react/index.js').isFile()).toBe(true);
		expect(fs.stat('/node_modules/react').isDirectory()).toBe(true);
		expect(fs.stat('/node_modules/react/package.json').size).toBe('{"name":"react"}'.length);
	});

	it('merges base and overlay entries in readdir, with the overlay winning', () => {
		const fs = withVendored();
		fs.writeFile('/node_modules/react/extra.js', 'overlay');
		fs.writeFile('/node_modules/react/index.js', 'shadowed');
		const names = fs
			.readdir('/node_modules/react')
			.map((entry) => entry.name)
			.toSorted();
		expect(names).toEqual(['extra.js', 'index.js', 'package.json']);
		expect(fs.readFileText('/node_modules/react/index.js')).toBe('shadowed');
	});

	it('hides a base file once removed (tombstone)', () => {
		const fs = withVendored();
		fs.remove('/node_modules/react/index.js');
		expect(fs.exists('/node_modules/react/index.js')).toBe(false);
		expect(() => fs.readFileText('/node_modules/react/index.js')).toThrowError(FileSystemError);
		// A later write resurrects the path from the overlay.
		fs.writeFile('/node_modules/react/index.js', 'rewritten');
		expect(fs.readFileText('/node_modules/react/index.js')).toBe('rewritten');
	});

	it('hides a base subtree on recursive remove', () => {
		const fs = withVendored();
		fs.remove('/node_modules', { recursive: true });
		expect(fs.exists('/node_modules')).toBe(false);
		expect(fs.exists('/node_modules/react/index.js')).toBe(false);
	});

	it('filePaths includes base and overlay files; readFilesUnder is overlay-only', () => {
		const fs = withVendored();
		fs.writeFile('/app/page.tsx', 'page');
		fs.writeFile('/dist/server/index.js', 'server-output');
		expect(fs.filePaths().toSorted()).toEqual([
			'/app/page.tsx',
			'/dist/server/index.js',
			'/node_modules/react/index.js',
			'/node_modules/react/package.json',
		]);
		expect(fs.readFilesUnder('/dist/server')).toEqual({ 'index.js': 'server-output' });
	});
});

// A trivial reversible "decompression" (reverse the stored string) stands in
// for gzip+base64 so the test stays pure and deterministic.
const reverseString = (value: string): string => [...value].toReversed().join('');

describe('VendoredLayer.fromCompressedRecord', () => {
	const decompress = reverseString;
	const encode = reverseString;

	function withCompressed(): { fs: MemoryFileSystem; calls: () => number } {
		let count = 0;
		const fs = new MemoryFileSystem();
		fs.addBaseLayer(
			VendoredLayer.fromCompressedRecord(
				{
					'node_modules/react/index.js': encode('module.exports = {};'),
					'node_modules/react/package.json': encode('{"name":"react"}'),
				},
				(stored) => {
					count += 1;
					return decompress(stored);
				},
				'/',
			),
		);
		return { fs, calls: () => count };
	}

	it('decompresses file contents lazily on read', () => {
		const { fs, calls } = withCompressed();
		// Directory/existence checks must not trigger any decompression.
		expect(fs.exists('/node_modules/react/index.js')).toBe(true);
		expect(
			fs
				.readdir('/node_modules/react')
				.map((entry) => entry.name)
				.toSorted(),
		).toEqual(['index.js', 'package.json']);
		expect(calls()).toBe(0);

		expect(fs.readFileText('/node_modules/react/index.js')).toBe('module.exports = {};');
		expect(calls()).toBe(1);
	});

	it('caches decompressed contents (decompresses each file at most once)', () => {
		const { fs, calls } = withCompressed();
		fs.readFileText('/node_modules/react/index.js');
		fs.readFileText('/node_modules/react/index.js');
		fs.stat('/node_modules/react/index.js'); // size also uses the decompressed text
		expect(calls()).toBe(1);
	});

	it('reports the decompressed byte length from stat', () => {
		const { fs } = withCompressed();
		expect(fs.stat('/node_modules/react/package.json').size).toBe('{"name":"react"}'.length);
	});
});
