import { describe, expect, it } from 'vitest';

import { ViteHost } from './vite-host';

import type { Plugin } from './types';

describe('ViteHost', () => {
	it('installs the filesystem before invoking the plugin factory', async () => {
		let sawAppDirectory = false;
		const host = await ViteHost.create({
			files: { '/app/page.tsx': 'export default () => null;' },
			root: '/',
			command: 'serve',
			mode: 'development',
			createPlugins: async () => {
				// The factory runs after fs install, so plugins can read the tree.
				const { existsSync } = await import('./node-fs/node-fs');
				sawAppDirectory = existsSync('/app');
				const plugin: Plugin = { name: 'reader' };
				return [plugin];
			},
		});
		expect(sawAppDirectory).toBe(true);
		expect(host.pluginNames).toContain('reader');
	});

	it('bundles a virtual entry through the resolved plugin set', async () => {
		const plugin: Plugin = {
			name: 'app',
			resolveId: (source) => (source === 'virtual:app' ? source : undefined),
			load: (id) => (id === 'virtual:app' ? 'import { n } from "/n.ts";\nexport const total = n + 1;' : undefined),
		};
		const host = await ViteHost.create({
			files: { '/n.ts': 'export const n: number = 10;' },
			root: '/',
			command: 'serve',
			mode: 'development',
			createPlugins: () => [plugin],
		});

		const { code } = await host.bundle({ entryId: 'virtual:app', environment: 'rsc' });
		expect(code).toContain('n = 10');
		expect(code).toContain('total =');
	});

	it('assembles the full vinext App Router plugin set including RSC plugins', async () => {
		const host = await ViteHost.create({
			files: {
				'/app/page.tsx': 'export default function Page() { return <h1>Hi</h1>; }',
				'/app/layout.tsx': 'export default function Layout({ children }) { return children; }',
				'/package.json': JSON.stringify({ name: 'demo', type: 'module' }),
			},
			root: '/',
			command: 'serve',
			mode: 'development',
			createPlugins: async () => {
				const { vinext } = await import('../../../auxiliary/vite-host/vendor/native-plugins.mjs');
				return vinext({ appDir: '/' });
			},
		});

		// vinext's own plugins…
		expect(host.pluginNames).toContain('vinext:config');
		expect(host.pluginNames).toContain('vinext:pages-router');
		// …plus the RSC plugins it contributes via a promise entry in its array.
		expect(host.pluginNames.some((name) => name.startsWith('rsc:'))).toBe(true);
	});
});
