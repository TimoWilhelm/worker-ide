import { describe, expect, it } from 'vitest';

import { getRuntimeById, selectRuntime } from './registry';

const vinextManifest = JSON.stringify({ dependencies: { vinext: '^0.1.0' } });
const reactManifest = JSON.stringify({ dependencies: { react: '^19.0.0' } });

describe('selectRuntime', () => {
	it('selects the vinext runtime for a vinext App Router project', () => {
		const runtime = selectRuntime({ files: { '/package.json': vinextManifest, '/app/page.tsx': '' } });
		expect(runtime.id).toBe('vinext');
		expect(runtime.hosting).toBe('durable');
	});

	it('falls back to the react-spa runtime for a plain SPA project', () => {
		const runtime = selectRuntime({ files: { '/package.json': reactManifest, '/index.html': '<html></html>', '/src/main.tsx': '' } });
		expect(runtime.id).toBe('react-spa');
		expect(runtime.hosting).toBe('stateless');
	});

	it('falls back to the react-spa runtime when there is no manifest', () => {
		expect(selectRuntime({ files: {} }).id).toBe('react-spa');
	});

	it('does not select vinext without an app/pages directory', () => {
		expect(selectRuntime({ files: { '/package.json': vinextManifest } }).id).toBe('react-spa');
	});
});

describe('getRuntimeById', () => {
	it('looks up registered runtimes and returns undefined otherwise', () => {
		expect(getRuntimeById('vinext')?.id).toBe('vinext');
		expect(getRuntimeById('react-spa')?.id).toBe('react-spa');
		expect(getRuntimeById('svelte')).toBeUndefined();
	});
});
