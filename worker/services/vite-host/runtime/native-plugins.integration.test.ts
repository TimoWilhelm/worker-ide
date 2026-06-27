/**
 * Integration: the vendored native-plugins bundle must import and instantiate
 * inside workerd. This is the definitive Phase 0/1 proof that vinext +
 * @vitejs/plugin-rsc run in the host runtime via the esbuild + shim path.
 */
import { describe, expect, it } from 'vitest';

import { rsc, vinext } from '../../../../auxiliary/vite-host/vendor/native-plugins.mjs';
import { MemoryFileSystem } from '../node-fs/memory-file-system';
import { installProjectFileSystem } from '../node-fs/node-fs-bridge';
import { installViteHostServices } from '../vite-shim/services';

describe('vendored native plugins in workerd', () => {
	it('instantiates @vitejs/plugin-rsc', () => {
		const plugins = [rsc({ entries: { rsc: 'virtual:rsc', ssr: 'virtual:ssr', client: 'virtual:client' } })]
			.flat(Infinity)
			.filter(Boolean)
			.map((plugin: { name?: string }) => plugin.name);
		console.log('[integration] plugin-rsc:', JSON.stringify(plugins));
		expect(plugins.length).toBeGreaterThan(0);
	});

	it('instantiates vinext (App Router) against a project filesystem', async () => {
		installProjectFileSystem(
			MemoryFileSystem.fromSnapshot({
				'/app/page.tsx': 'export default function Page() { return <h1>Hi</h1>; }',
				'/app/layout.tsx': 'export default function Layout({ children }) { return children; }',
				'/package.json': JSON.stringify({ name: 'demo', type: 'module' }),
			}),
		);
		installViteHostServices({
			transform: async (code) => ({ code }),
			loadEnv: () => ({}),
		});
		const plugins = [await vinext()]
			.flat(Infinity)
			.filter(Boolean)
			.map((plugin: { name?: string }) => plugin.name);
		// Assert the real vinext plugin set wired up — not merely a non-empty array.
		expect(plugins).toContain('vinext:config');
		expect(plugins).toContain('vinext:pages-router');
		expect(plugins).toContain('vinext:strip-server-exports');
		expect(plugins).toContain('vinext:wasm-module-import');
	});
});
