import { describe, expect, it } from 'vitest';

import { clientAssetResponse, resolveClientAsset } from './client-assets';

const CLIENT_OUTPUT: Record<string, string> = {
	'index.js': 'console.log("client entry")',
	'vinext-client-entry-manifest.json': '{"entries":[]}',
	'_next/static/abc123/_buildManifest.js': 'self.__BUILD_MANIFEST = {}',
	'assets/style-deadbeef.css': '.x{color:red}',
	'__react/client/react.js': 'export default {}',
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

	it('serves the vendored React runtime with a moderate TTL (deploy-stable, never user code)', () => {
		const asset = resolveClientAsset(CLIENT_OUTPUT, '/__react/client/react.js');
		if (asset === undefined) throw new Error('expected asset');
		// Not immutable (unversioned URL), but cacheable since it never changes on a user edit.
		expect(asset.immutable).toBe(false);
		const response = clientAssetResponse(asset);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
	});

	it('omits an ETag when no build id is provided', () => {
		const asset = resolveClientAsset(CLIENT_OUTPUT, '/index.js');
		if (asset === undefined) throw new Error('expected asset');
		expect(clientAssetResponse(asset).headers.get('ETag')).toBeNull();
	});

	it('tags the asset with a build-scoped ETag when a build id is provided', async () => {
		const asset = resolveClientAsset(CLIENT_OUTPUT, '/index.js');
		if (asset === undefined) throw new Error('expected asset');
		const response = clientAssetResponse(asset, new Request('https://preview.test/index.js'), 'snap123');
		expect(response.headers.get('ETag')).toBe('"snap123-index.js"');
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('client entry');
	});

	it('returns a bodyless 304 when If-None-Match matches the build ETag', async () => {
		const asset = resolveClientAsset(CLIENT_OUTPUT, '/index.js');
		if (asset === undefined) throw new Error('expected asset');
		const request = new Request('https://preview.test/index.js', { headers: { 'If-None-Match': '"snap123-index.js"' } });
		const response = clientAssetResponse(asset, request, 'snap123');
		expect(response.status).toBe(304);
		expect(response.headers.get('ETag')).toBe('"snap123-index.js"');
		expect(response.headers.get('Cache-Control')).toBe('no-cache');
		expect(await response.text()).toBe('');
	});

	it('serves fresh content (200) when the build id changed since the cached ETag', async () => {
		const asset = resolveClientAsset(CLIENT_OUTPUT, '/index.js');
		if (asset === undefined) throw new Error('expected asset');
		const request = new Request('https://preview.test/index.js', { headers: { 'If-None-Match': '"old-index.js"' } });
		const response = clientAssetResponse(asset, request, 'snap123');
		expect(response.status).toBe(200);
		expect(response.headers.get('ETag')).toBe('"snap123-index.js"');
		expect(await response.text()).toContain('client entry');
	});
});
