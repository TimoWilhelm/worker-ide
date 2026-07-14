/**
 * Integration: build vinext's App Router RSC server environment end-to-end in
 * workerd. Exercises the full pipeline — vendored native plugins, the config
 * lifecycle, the seeded vinext runtime, hook filters, the `skipSelf` resolution
 * semantics, and the esbuild bridge — producing a real RSC server bundle.
 */
import { describe, expect, it } from 'vitest';

import { ViteHost } from '../vite-host';
import { seedVinextRuntime } from './seed-vinext-runtime';
import { SERVER_RUNTIME_EXTERNALS } from './server-externals';

const APP_ROUTER_FILES = {
	'/app/page.tsx': 'export default function Page() { return <h1>Hello vinext</h1>; }',
	'/app/layout.tsx':
		'export default function RootLayout({ children }: { children: React.ReactNode }) { return (<html><body>{children}</body></html>); }',
	'/package.json': JSON.stringify({ name: 'demo', type: 'module' }),
};

async function createVinextHost(): Promise<ViteHost> {
	return ViteHost.create({
		files: APP_ROUTER_FILES,
		root: '/',
		command: 'build',
		mode: 'production',
		createPlugins: async () => {
			const { vinext } = await import('../../../../auxiliary/vite-host/vendor/native-plugins.mjs');
			return vinext({ appDir: '/' });
		},
		seedRuntime: seedVinextRuntime,
	});
}

describe('vinext App Router RSC build', () => {
	it('bundles the RSC server environment into runnable ESM', async () => {
		const host = await createVinextHost();
		const bundle = await host.bundleServerEnvironment({
			entryId: 'virtual:vinext-rsc-entry',
			environment: 'rsc',
			externals: [...SERVER_RUNTIME_EXTERNALS],
		});

		expect(bundle.files.length).toBeGreaterThan(0);
		const entry = bundle.files.find((file) => file.isEntry) ?? bundle.files[0];
		expect(entry.text.length).toBeGreaterThan(1000);
		// The RSC entry wires vinext's app-router handler and the user's page.
		expect(entry.text).toContain('Hello vinext');
	}, 120_000);

	it('runs the full multi-environment build, emitting the server + ssr bundles and manifests', async () => {
		const host = await createVinextHost();
		await host.build([...SERVER_RUNTIME_EXTERNALS]);

		// vinext's build layout: the RSC server bundle, the SSR child bundle, and
		// the RSC assets manifest shared between them.
		const serverBundle = host.readFile('/dist/server/index.js');
		const ssrBundle = host.readFile('/dist/server/ssr/index.js');
		expect(serverBundle).toContain('Hello vinext');
		expect(serverBundle.length).toBeGreaterThan(1000);
		expect(ssrBundle.length).toBeGreaterThan(1000);
		expect(host.readFile('/dist/server/__vite_rsc_assets_manifest.js').length).toBeGreaterThan(0);
	}, 120_000);
});
