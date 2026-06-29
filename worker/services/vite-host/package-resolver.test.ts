import { describe, expect, it } from 'vitest';

import { MemoryFileSystem } from './node-fs/memory-file-system';
import { parsePackageSpecifier, resolvePackage } from './package-resolver';

describe('parsePackageSpecifier', () => {
	it('splits scoped and unscoped specifiers', () => {
		expect(parsePackageSpecifier('react')).toEqual({ packageName: 'react', subpath: undefined });
		expect(parsePackageSpecifier('react/jsx-runtime')).toEqual({ packageName: 'react', subpath: 'jsx-runtime' });
		expect(parsePackageSpecifier('@vitejs/plugin-rsc')).toEqual({ packageName: '@vitejs/plugin-rsc', subpath: undefined });
		expect(parsePackageSpecifier('@vitejs/plugin-rsc/react/rsc')).toEqual({
			packageName: '@vitejs/plugin-rsc',
			subpath: 'react/rsc',
		});
	});
});

describe('resolvePackage', () => {
	it('selects the export branch matching the conditions', () => {
		const fs = MemoryFileSystem.fromSnapshot({
			'/node_modules/demo/package.json': JSON.stringify({
				name: 'demo',
				exports: {
					'.': {
						'react-server': './server.js',
						default: './client.js',
					},
				},
			}),
			'/node_modules/demo/server.js': 'export const where = "server";',
			'/node_modules/demo/client.js': 'export const where = "client";',
		});

		expect(resolvePackage('demo', fs, ['react-server', 'default'])?.path).toBe('/node_modules/demo/server.js');
		expect(resolvePackage('demo', fs, ['default'])?.path).toBe('/node_modules/demo/client.js');
	});

	it('resolves subpath exports', () => {
		const fs = MemoryFileSystem.fromSnapshot({
			'/node_modules/react/package.json': JSON.stringify({
				name: 'react',
				exports: { '.': './index.js', './jsx-runtime': './jsx-runtime.js' },
			}),
			'/node_modules/react/index.js': 'export default {};',
			'/node_modules/react/jsx-runtime.js': 'export const jsx = () => {};',
		});
		expect(resolvePackage('react/jsx-runtime', fs, ['default'])?.path).toBe('/node_modules/react/jsx-runtime.js');
	});

	it('falls back to legacy main/module fields', () => {
		const fs = MemoryFileSystem.fromSnapshot({
			'/node_modules/legacy/package.json': JSON.stringify({ name: 'legacy', main: './lib/index.js' }),
			'/node_modules/legacy/lib/index.js': 'module.exports = {};',
		});
		expect(resolvePackage('legacy', fs, ['default'])?.path).toBe('/node_modules/legacy/lib/index.js');
	});

	it('returns undefined for an absent package', () => {
		const fs = new MemoryFileSystem();
		expect(resolvePackage('missing', fs, ['default'])).toBeUndefined();
	});
});
