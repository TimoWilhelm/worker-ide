/**
 * Integration: render a vinext App Router route end-to-end in workerd.
 *
 * Builds the full app (rsc worker + ssr) with React resolved from vendored
 * source via per-environment conditions, runs the worker module set in a LOADER
 * isolate, and asserts the route renders to HTML.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { routeAppRequest } from './app-runtime';
import { getServerEntrypoint, serverModulesFromOutput } from './loader-runner';
import { SERVER_RUNTIME_EXTERNALS } from './server-externals';
import { ViteHost } from '../vite-host';

const APP_ROUTER_ENTRY = '/__vinext__/dist/server/app-router-entry.js';

const FILES = {
	'/app/page.tsx': 'export default function Page() { return <h1>Hello vinext</h1>; }',
	'/app/layout.tsx':
		'export default function RootLayout({ children }: { children: React.ReactNode }) { return (<html><body>{children}</body></html>); }',
	'/package.json': JSON.stringify({ name: 'demo', type: 'module' }),
};

describe('vinext App Router render', () => {
	it('renders a route to HTML in a LOADER isolate', async () => {
		const host = await ViteHost.create({
			files: FILES,
			root: '/',
			command: 'build',
			mode: 'production',
			createPlugins: async () => {
				const { vinext } = await import('../../../../auxiliary/vite-host/vendor/native-plugins.mjs');
				return vinext();
			},
		});
		await host.build([...SERVER_RUNTIME_EXTERNALS], APP_ROUTER_ENTRY);

		const output = host.readOutput('/dist/server');
		expect(output['index.js']).toBeDefined();
		expect(output['ssr/index.js']).toBeDefined();

		const entrypoint = getServerEntrypoint({
			loader: env.LOADER,
			cacheKey: `vinext-render:${Date.now()}`,
			moduleSet: {
				compatibilityDate: '2025-06-01',
				compatibilityFlags: ['nodejs_compat', 'enable_nodejs_fs_module'],
				mainModule: 'index.js',
				modules: serverModulesFromOutput(output),
			},
		});

		const clientOutput = host.readOutput('/dist/client');
		const sources = { clientOutput, server: entrypoint };

		const response = await routeAppRequest(new Request('https://example.com/'), sources);
		const body = await response.text();

		// End-to-end: the built worker runs in a LOADER isolate and server-renders
		// a full HTML document. Client components resolve via the client-reference
		// module map, so the route's markup (the `<h1>`) is present in the SSR HTML
		// — not just streamed as an RSC payload.
		expect(response.status).toBe(200);
		expect(body.startsWith('<!DOCTYPE html>')).toBe(true);
		expect(body).toContain('<h1>Hello vinext</h1>');
		expect(body).not.toContain('__next_error__');
		expect(body).toContain('vinext.navigationRuntime');

		// The HTML references the client entry at `/index.js`; the router serves it
		// from the client build output instead of delegating to the server isolate.
		const clientEntry = await routeAppRequest(new Request('https://example.com/index.js'), sources);
		expect(clientEntry.status).toBe(200);
		expect(clientEntry.headers.get('Content-Type')).toBe('application/javascript');
		const clientEntryText = await clientEntry.text();
		expect(clientEntryText.length).toBeGreaterThan(0);
	}, 180_000);
});
