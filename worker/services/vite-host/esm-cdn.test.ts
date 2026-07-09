import { describe, expect, it, vi } from 'vitest';

import { buildEsmCdnUrl, ESM_CDN_ORIGIN, fetchEsmModule, isEsmCdnExcluded, readDependencyVersions, resolveEsmCdnImport } from './esm-cdn';
import { MemoryFileSystem } from './node-fs/memory-file-system';

describe('readDependencyVersions', () => {
	it('reads runtime dependencies only (never devDependencies)', () => {
		const fileSystem = MemoryFileSystem.fromSnapshot({
			'/package.json': JSON.stringify({
				dependencies: { 'react-confetti': '6.4.1', react: '^19.0.0' },
				devDependencies: { typescript: '^5.0.0', vinext: '^0.1.8', vite: '^6.0.0' },
			}),
		});
		const versions = readDependencyVersions(fileSystem);
		expect(versions.get('react-confetti')).toBe('6.4.1');
		expect(versions.get('react')).toBe('^19.0.0');
		// Toolchain devDependencies must NOT be CDN-fetched.
		expect(versions.has('typescript')).toBe(false);
		expect(versions.has('vinext')).toBe(false);
		expect(versions.has('vite')).toBe(false);
	});

	it('returns an empty map when package.json is missing or invalid', () => {
		expect(readDependencyVersions(MemoryFileSystem.fromSnapshot({})).size).toBe(0);
		expect(readDependencyVersions(MemoryFileSystem.fromSnapshot({ '/package.json': 'not json' })).size).toBe(0);
	});
});

describe('isEsmCdnExcluded', () => {
	it('excludes the React/RSC runtime family', () => {
		expect(isEsmCdnExcluded('react')).toBe(true);
		expect(isEsmCdnExcluded('react-dom')).toBe(true);
		expect(isEsmCdnExcluded('react-server-dom-webpack')).toBe(true);
	});

	it('excludes the Vite/vinext build toolchain (avoids the vite -> @vitejs/devtools -> devframe cascade)', () => {
		expect(isEsmCdnExcluded('vite')).toBe(true);
		expect(isEsmCdnExcluded('vinext')).toBe(true);
		expect(isEsmCdnExcluded('@vitejs/devtools')).toBe(true);
		expect(isEsmCdnExcluded('@vitejs/plugin-rsc')).toBe(true);
	});

	it('includes ordinary runtime packages', () => {
		expect(isEsmCdnExcluded('react-confetti')).toBe(false);
		expect(isEsmCdnExcluded('lodash')).toBe(false);
		expect(isEsmCdnExcluded('@scope/pkg')).toBe(false);
	});
});

describe('buildEsmCdnUrl', () => {
	it('pins a concrete version and externalizes React', () => {
		expect(buildEsmCdnUrl('react-confetti', '6.4.1')).toBe(
			`${ESM_CDN_ORIGIN}/react-confetti@6.4.1?target=es2022&external=react,react-dom,react-server-dom-webpack`,
		);
	});

	it('passes semver ranges through (esm.sh resolves them)', () => {
		expect(buildEsmCdnUrl('react-confetti', '^6.4.0')).toContain('react-confetti@^6.4.0?');
	});

	it('omits the version for "*" or empty', () => {
		expect(buildEsmCdnUrl('lodash', '*')).toContain('/lodash?');
		expect(buildEsmCdnUrl('lodash')).toContain('/lodash?');
	});

	it('preserves subpaths and scoped packages', () => {
		expect(buildEsmCdnUrl('date-fns/format', '3.0.0')).toContain('/date-fns@3.0.0/format?');
		expect(buildEsmCdnUrl('@scope/pkg/sub', '1.2.3')).toContain('/@scope/pkg@1.2.3/sub?');
	});
});

describe('resolveEsmCdnImport', () => {
	it('resolves absolute and relative imports against the esm.sh URL', () => {
		expect(resolveEsmCdnImport(`${ESM_CDN_ORIGIN}/react-confetti@6.4.1`, '/react-confetti@6.4.1/es2022/x.mjs')).toBe(
			`${ESM_CDN_ORIGIN}/react-confetti@6.4.1/es2022/x.mjs`,
		);
		expect(resolveEsmCdnImport(`${ESM_CDN_ORIGIN}/a/b/c.mjs`, './d.mjs')).toBe(`${ESM_CDN_ORIGIN}/a/b/d.mjs`);
	});
});

describe('fetchEsmModule', () => {
	it('fetches source and caches by URL (one network call per URL)', async () => {
		const fetchImplementation = vi.fn(async () => new Response('export default 1;', { status: 200 }));
		const url = `${ESM_CDN_ORIGIN}/react-confetti@6.4.1?x`;

		const first = await fetchEsmModule(url, fetchImplementation);
		const second = await fetchEsmModule(url, fetchImplementation);

		expect(first).toBe('export default 1;');
		expect(second).toBe('export default 1;');
		expect(fetchImplementation).toHaveBeenCalledTimes(1);
	});

	it('throws a descriptive error on a 404', async () => {
		const fetchImplementation = vi.fn(async () => new Response('not found', { status: 404, statusText: 'Not Found' }));
		await expect(fetchEsmModule(`${ESM_CDN_ORIGIN}/nope@1.0.0`, fetchImplementation)).rejects.toThrow(/package or version not found/);
	});
});
