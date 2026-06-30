/**
 * Integration: a registered third-party dependency that is NOT in the vendored
 * node_modules (e.g. `react-confetti`) is fetched from esm.sh at build time and
 * inlined into the vinext server bundle — instead of being left as a bare
 * external that fails at load time with `No such module "ssr/<pkg>"`.
 *
 * The esm.sh fetch is stubbed so the test is hermetic (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearEsmModuleCache } from '../esm-cdn';
import { ViteHost } from '../vite-host';
import { seedVinextRuntime } from './seed-vinext-runtime';
import { SERVER_RUNTIME_EXTERNALS } from './server-externals';

const CONFETTI_MARKER = 'confetti_marker_b3c1f';

// A stand-in for the package esm.sh would serve. Deliberately tiny and free of
// browser globals so it renders server-side in the SSR/RSC environments. It
// also imports `react` (must dedupe to the vendored instance) and `vite` (a
// build-toolchain package that must be left external, NEVER fetched — guarding
// the vite -> @vitejs/devtools -> devframe cascade).
const FAKE_CONFETTI_MODULE = `import 'react';
import 'vite';
export const CONFETTI_MARKER = ${JSON.stringify(CONFETTI_MARKER)};
export default function Confetti() { return null; }
`;

const APP_ROUTER_FILES = {
	'/app/page.tsx': `import Confetti, { CONFETTI_MARKER } from 'react-confetti';
export default function Page() { return (<div><h1>{CONFETTI_MARKER}</h1><Confetti /></div>); }`,
	'/app/layout.tsx':
		'export default function RootLayout({ children }: { children: React.ReactNode }) { return (<html><body>{children}</body></html>); }',
	'/package.json': JSON.stringify({
		name: 'demo',
		type: 'module',
		dependencies: { 'react-confetti': '6.4.1' },
	}),
};

async function createVinextHost(): Promise<ViteHost> {
	return ViteHost.create({
		files: APP_ROUTER_FILES,
		root: '/',
		command: 'build',
		mode: 'production',
		createPlugins: async () => {
			const { vinext } = await import('../../../../auxiliary/vite-host/vendor/native-plugins.mjs');
			return vinext();
		},
		seedRuntime: seedVinextRuntime,
	});
}

describe('vinext esm.sh dependency fallback', () => {
	beforeEach(() => {
		clearEsmModuleCache();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes('esm.sh') && url.includes('react-confetti')) {
					return new Response(FAKE_CONFETTI_MODULE, { status: 200, headers: { 'content-type': 'application/javascript' } });
				}
				return new Response('not found', { status: 404, statusText: 'Not Found' });
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('fetches a registered dep from esm.sh and inlines it, without fetching toolchain packages it imports', async () => {
		const host = await createVinextHost();
		await host.build([...SERVER_RUNTIME_EXTERNALS]);

		const serverBundle = host.readFile('/dist/server/index.js');
		// The dependency's source was inlined (proves esm.sh fetch + bundle), not
		// left as a bare external that would fail at load.
		expect(serverBundle).toContain(CONFETTI_MARKER);

		// react-confetti was fetched...
		const fetchedUrls = vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]));
		expect(fetchedUrls.some((url) => url.includes('react-confetti'))).toBe(true);
		// ...but `vite` (imported by the fetched module) was left external, NEVER
		// fetched — preventing the vite -> @vitejs/devtools -> devframe cascade.
		expect(fetchedUrls.some((url) => url.includes('esm.sh') && /[/@]vite/.test(url))).toBe(false);
	}, 120_000);
});
