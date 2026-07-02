import { describe, expect, it } from 'vitest';

import { createBaseResolvedConfig } from './config/resolve-config';
import { bundleModuleGraph } from './esbuild-bridge';
import { ensureEsbuild } from './esbuild-runtime';
import { MemoryFileSystem } from './node-fs/memory-file-system';
import { PluginContainer } from './plugin-container';

import type { Plugin, ResolvedConfig } from './types';

function makeConfig(): ResolvedConfig {
	return createBaseResolvedConfig({ command: 'serve', mode: 'development', root: '/' });
}

describe('esbuild bridge to plugin container', () => {
	it('bundles a virtual entry that imports a filesystem module, applying a transform', async () => {
		const esbuild = await ensureEsbuild();
		const fileSystem = MemoryFileSystem.fromSnapshot({
			'/src/util.ts': 'export const value: number = 41;',
		});

		// A plugin that provides a virtual entry importing a real fs module, plus
		// a transform that rewrites a marker — exercising resolveId + load +
		// transform delegation through esbuild.
		const plugin: Plugin = {
			name: 'virtual-entry',
			resolveId(source) {
				if (source === 'virtual:entry') {
					return source;
				}
				return;
			},
			load(id) {
				if (id === 'virtual:entry') {
					return 'import { value } from "/src/util.ts";\nexport const result = value + ONE;';
				}
				return;
			},
			transform(code) {
				return code.replace('ONE', '1');
			},
		};

		const container = PluginContainer.create({
			config: makeConfig(),
			plugins: [plugin],
			parse: () => ({}),
		});

		const { code } = await bundleModuleGraph({
			esbuild,
			container,
			fileSystem,
			entryId: 'virtual:entry',
			environment: 'rsc',
			externals: [],
		});

		// The fs module's TS annotation was stripped by esbuild, the transform
		// replaced ONE→1, and the graph was bundled into one module.
		expect(code).toContain('value = 41');
		expect(code).toContain('result =');
		expect(code).not.toContain('ONE');
	});

	it('leaves configured bare specifiers external', async () => {
		const esbuild = await ensureEsbuild();
		const fileSystem = new MemoryFileSystem();
		const plugin: Plugin = {
			name: 'entry',
			resolveId: (source) => (source === 'virtual:main' ? source : undefined),
			load: (id) => (id === 'virtual:main' ? 'import dep from "external-lib";\nexport default dep;' : undefined),
		};
		const container = PluginContainer.create({ config: makeConfig(), plugins: [plugin], parse: () => ({}) });

		const { code } = await bundleModuleGraph({
			esbuild,
			container,
			fileSystem,
			entryId: 'virtual:main',
			environment: 'rsc',
			externals: ['external-lib'],
		});

		expect(code).toContain('from "external-lib"');
	});
});
