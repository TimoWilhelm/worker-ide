import { describe, expect, it } from 'vitest';

import { MemoryFileSystem } from './memory-file-system';
import * as nodeFs from './node-fs';
import { installProjectFileSystem } from './node-fs-bridge';

function install(files: Record<string, string>): void {
	installProjectFileSystem(MemoryFileSystem.fromSnapshot(files));
}

describe('node:fs facade (sync)', () => {
	it('existsSync reflects the project tree and never throws', () => {
		install({ '/app/page.tsx': 'p' });
		expect(nodeFs.existsSync('/app/page.tsx')).toBe(true);
		expect(nodeFs.existsSync('/nope')).toBe(false);
	});

	it('readFileSync returns text with an encoding, bytes without', () => {
		install({ '/a.txt': 'hello' });
		expect(nodeFs.readFileSync('/a.txt', 'utf8')).toBe('hello');
		expect(nodeFs.readFileSync('/a.txt')).toBeInstanceOf(Uint8Array);
	});

	it('readdirSync supports withFileTypes', () => {
		install({ '/app/page.tsx': 'p', '/app/blog/page.tsx': 'b' });
		expect((nodeFs.readdirSync('/app') as string[]).toSorted()).toEqual(['blog', 'page.tsx']);
		const entries = nodeFs.readdirSync('/app', { withFileTypes: true });
		const blog = entries.find((entry) => (typeof entry === 'string' ? entry : entry.name) === 'blog');
		expect(typeof blog === 'string' ? false : blog?.isDirectory()).toBe(true);
	});

	it('writeFileSync persists into the project tree', () => {
		install({});
		nodeFs.writeFileSync('/generated/routes.d.ts', 'export {};');
		expect(nodeFs.readFileSync('/generated/routes.d.ts', 'utf8')).toBe('export {};');
	});
});

describe('node:fs facade (promises)', () => {
	it('reads and writes via the promise API', async () => {
		install({ '/a.txt': 'x' });
		expect(await nodeFs.promises.readFile('/a.txt', 'utf8')).toBe('x');
		await nodeFs.promises.writeFile('/b.txt', 'y');
		expect(await nodeFs.promises.readFile('/b.txt', 'utf8')).toBe('y');
	});

	it('access rejects for missing files', async () => {
		install({});
		await expect(nodeFs.promises.access('/missing')).rejects.toThrow('ENOENT');
	});
});
