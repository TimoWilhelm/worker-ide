import { describe, expect, it } from 'vitest';

import { runBuildApp } from './build-app';
import { createBaseResolvedConfig } from './config/resolve-config';
import { EmittedFiles } from './emitted-files';
import { ensureEsbuild } from './esbuild-runtime';
import { MemoryFileSystem } from './node-fs/memory-file-system';
import { PluginContainer } from './plugin-container';

import type { Plugin } from './types';

describe('runBuildApp orchestration', () => {
	it('drives a plugin buildApp hook through scan + build passes and writes outputs', async () => {
		const esbuild = await ensureEsbuild();
		const fileSystem = MemoryFileSystem.fromSnapshot({});
		const events: string[] = [];

		// A synthetic plugin mirroring plugin-rsc's contract: it provides the
		// three virtual entries, registers buildApp, and toggles build.write to
		// run scan passes before real build passes.
		const plugin: Plugin = {
			name: 'synthetic-rsc',
			resolveId: (source) => (source.startsWith('virtual:') ? source : undefined),
			load: (id) => (id.startsWith('virtual:') ? `export const env = ${JSON.stringify(id)};` : undefined),
			generateBundle(_options, bundle, isWrite) {
				events.push(`generateBundle:${this.environment.name}:write=${isWrite}`);
				if (isWrite) {
					// plugin-rsc emits manifests during the real build passes.
					bundle['manifest.json'] = {
						type: 'asset',
						fileName: 'manifest.json',
						name: 'manifest',
						names: ['manifest'],
						source: '{"ok":true}',
					};
				}
			},
			writeBundle() {
				events.push(`writeBundle:${this.environment.name}`);
			},
			buildApp: async (builder) => {
				builder.environments.rsc.config.build.write = false;
				await builder.build(builder.environments.rsc);
				builder.environments.rsc.config.build.write = true;
				await builder.build(builder.environments.rsc);
				await builder.build(builder.environments.client);
				await builder.build(builder.environments.ssr);
			},
		};

		const config = createBaseResolvedConfig({
			command: 'build',
			mode: 'production',
			root: '/',
			plugins: [plugin],
			environments: {
				rsc: { build: { outDir: 'dist/rsc', rollupOptions: { input: { index: 'virtual:rsc' } } } },
				ssr: { build: { outDir: 'dist/ssr', rollupOptions: { input: { index: 'virtual:ssr' } } } },
				client: { build: { outDir: 'dist/client', rollupOptions: { input: { index: 'virtual:client' } } } },
			},
		});
		const container = new PluginContainer({ config, plugins: [plugin], parse: () => ({}) });

		await runBuildApp({ esbuild, container, fileSystem, config, externals: [], emittedFiles: new EmittedFiles() });

		// Scan pass (write=false) does not write; the three real passes do.
		expect(events).toContain('generateBundle:rsc:write=false');
		expect(events).toContain('generateBundle:rsc:write=true');
		expect(events).toContain('writeBundle:client');
		expect(events).toContain('writeBundle:ssr');

		// Outputs and the emitted manifest were written for real passes.
		expect(fileSystem.exists('/dist/rsc/index.js')).toBe(true);
		expect(fileSystem.exists('/dist/client/index.js')).toBe(true);
		expect(fileSystem.readFileText('/dist/rsc/manifest.json')).toContain('"ok":true');
		// The scan pass must not have written rsc output before the real pass…
		// (we can only assert the final state: the real pass wrote it).
		expect(fileSystem.readFileText('/dist/rsc/index.js')).toContain('virtual:rsc');
	});
});
