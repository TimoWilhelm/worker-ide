/**
 * Integration: the shared React runtime builder compiles the React closure into
 * standalone modules with the closure mutually externalised (single instance).
 */
import { describe, expect, it } from 'vitest';

import { ensureEsbuild } from '../esbuild-runtime';
import { buildReactRuntimeModules, runtimeImportPath, runtimeModuleFileName } from './react-runtime-modules';
import { seedNodeModules } from './seed-node-modules';
import { MemoryFileSystem } from '../node-fs/memory-file-system';

const PROD_DEFINE = { 'process.env.NODE_ENV': '"production"' };

describe('buildReactRuntimeModules', () => {
	it('emits standalone server React modules that share one instance via sibling paths', async () => {
		const esbuild = await ensureEsbuild();
		const fileSystem = MemoryFileSystem.fromSnapshot({});
		seedNodeModules(fileSystem, { includeDevelopment: false });

		const modules = await buildReactRuntimeModules({ esbuild, fileSystem, environment: 'ssr', define: PROD_DEFINE });

		const reactName = runtimeModuleFileName('ssr', 'react');
		const reactDomName = runtimeModuleFileName('ssr', 'react-dom');

		expect(Object.keys(modules)).toContain(reactName);
		expect(Object.keys(modules)).toContain(reactDomName);
		expect(modules[reactName].length).toBeGreaterThan(0);

		// The SSR reconciler reaches React via the sibling shared module rather
		// than inlining it, so every consumer shares one instance — and via a real
		// ESM `import` (the CJS→ESM shim), NOT a `__require` shim that workerd
		// cannot resolve.
		const serverEdge = modules[runtimeModuleFileName('ssr', 'react-dom/server.edge')];
		expect(serverEdge).toMatch(/import\s*\*\s*as\s+\w+\s+from\s*["']\.\/react\.js["']/);
		expect(serverEdge).not.toContain('__require("./react.js")');
	}, 120_000);

	it('references shared modules by root-absolute paths so any chunk depth resolves', () => {
		// esbuild emits this external string verbatim into every chunk, including
		// code-split + per-client-reference chunks under `chunks/`. A relative path
		// would only resolve from the output root (breaking nested chunks such as a
		// client component that pulls a vendor dependency); an absolute path
		// resolves identically everywhere.
		for (const environment of ['rsc', 'ssr', 'client'] as const) {
			expect(runtimeImportPath(environment, 'react')).toBe(`/__react/${environment}/react.js`);
		}
	});

	it('rsc react forwards the react-server named exports react-dom reads', async () => {
		const esbuild = await ensureEsbuild();
		const fileSystem = MemoryFileSystem.fromSnapshot({});
		seedNodeModules(fileSystem, { includeDevelopment: false });

		const modules = await buildReactRuntimeModules({ esbuild, fileSystem, environment: 'rsc', define: PROD_DEFINE });
		const rscReact = modules[runtimeModuleFileName('rsc', 'react')];

		// The rsc build resolves React's `react-server` build and re-exports its
		// named bindings (not just `default`) — react-dom's react-server runtime
		// reads `__SERVER_INTERNALS…` off React, so a default-only re-export would
		// fail the "react-server condition" check at runtime.
		expect(rscReact).toContain('react.react-server');
		expect(rscReact).toContain('__SERVER_INTERNALS');
	}, 120_000);

	it('emits browser client React modules', async () => {
		const esbuild = await ensureEsbuild();
		const fileSystem = MemoryFileSystem.fromSnapshot({});
		seedNodeModules(fileSystem, { includeDevelopment: false });

		const modules = await buildReactRuntimeModules({ esbuild, fileSystem, environment: 'client', define: PROD_DEFINE });

		expect(Object.keys(modules)).toContain(runtimeModuleFileName('client', 'react-dom/client'));
		expect(modules[runtimeModuleFileName('client', 'react-dom/client')]).toContain('./react-dom.js');
	}, 120_000);
});
