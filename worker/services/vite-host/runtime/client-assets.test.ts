import { describe, expect, it } from 'vitest';

import { clientAssetResponse, resolveClientAsset } from './client-assets';

const CLIENT_OUTPUT: Record<string, string> = {
	'index.js': 'console.log("client entry")',
	'vinext-client-entry-manifest.json': '{"entries":[]}',
	'_next/static/abc123/_buildManifest.js': 'self.__BUILD_MANIFEST = {}',
	'assets/style-deadbeef.css': '.x{color:red}',
};

describe('resolveClientAsset', () => {
	it('resolves the client entry from a root-relative path', () => {
		const asset = resolveClientAsset(CLIENT_OUTPUT, '/index.js');
		expect(asset).toBeDefined();
		expect(asset?.fileName).toBe('index.js');
		expect(asset?.contentType).toBe('application/javascript');
		expect(asset?.contents).toContain('client entry');
	});

	it('maps `/` to index.html', () => {
		expect(resolveClientAsset(CLIENT_OUTPUT, '/')).toBeUndefined();
	});

	it('resolves hashed `_next/static` assets and marks them immutable', () => {
		const asset = resolveClientAsset(CLIENT_OUTPUT, '/_next/static/abc123/_buildManifest.js');
		expect(asset?.immutable).toBe(true);
	});

	it('marks hashed `assets/` files immutable with the right content type', () => {
		const asset = resolveClientAsset(CLIENT_OUTPUT, '/assets/style-deadbeef.css');
		expect(asset?.contentType).toBe('text/css');
		expect(asset?.immutable).toBe(true);
	});

	it('treats the non-hashed entry as non-immutable', () => {
		expect(resolveClientAsset(CLIENT_OUTPUT, '/index.js')?.immutable).toBe(false);
	});

	it('ignores query strings when resolving', () => {
		expect(resolveClientAsset(CLIENT_OUTPUT, '/index.js?v=123')?.fileName).toBe('index.js');
	});

	it('returns undefined for unknown paths', () => {
		expect(resolveClientAsset(CLIENT_OUTPUT, '/does-not-exist.js')).toBeUndefined();
	});
});

describe('clientAssetResponse', () => {
	it('serves immutable assets with a long-lived cache header', async () => {
		const asset = resolveClientAsset(CLIENT_OUTPUT, '/_next/static/abc123/_buildManifest.js');
		if (asset === undefined) throw new Error('expected asset');
		const response = clientAssetResponse(asset);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(response.headers.get('Content-Type')).toBe('application/javascript');
		expect(await response.text()).toContain('__BUILD_MANIFEST');
	});

	it('serves the entry with no-cache', () => {
		const asset = resolveClientAsset(CLIENT_OUTPUT, '/index.js');
		if (asset === undefined) throw new Error('expected asset');
		const response = clientAssetResponse(asset);
		expect(response.headers.get('Cache-Control')).toBe('no-cache');
	});
});
