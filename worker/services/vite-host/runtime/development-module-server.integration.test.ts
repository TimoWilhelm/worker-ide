/**
 * Integration: the dev module server serves a vinext project's USER client
 * components UNBUNDLED, with React Fast Refresh + `import.meta.hot` wiring and
 * imports rewritten to dev URLs — the basis for module-level HMR.
 */
import { describe, expect, it } from 'vitest';

import { serveDevelopmentModule } from './development-module-server';
import { runWithHostDevelopmentMode } from './host-development-mode';
import { seedVinextRuntime } from './seed-vinext-runtime';
import { SERVER_RUNTIME_EXTERNALS } from './server-externals';
import { getTemplate } from '../../../templates';
import { stripIdeManagedConfig } from '../runtimes/vinext';
import { ViteHost } from '../vite-host';

const APP_ROUTER_ENTRY = '/__vinext__/dist/server/app-router-entry.js';

async function buildTemplateHost(): Promise<ViteHost> {
	const template = getTemplate('vinext');
	if (template === undefined) throw new Error('vinext template is not registered');
	// Mirror VinextRuntime.build: IDE-managed wrangler.jsonc is not a build input.
	const files = stripIdeManagedConfig(Object.fromEntries(Object.entries(template.files).map(([path, contents]) => [`/${path}`, contents])));
	const host = await ViteHost.create({
		files,
		root: '/',
		command: 'build',
		mode: 'production',
		createPlugins: async () => {
			const { vinext } = await import('../../../../auxiliary/vite-host/vendor/native-plugins.mjs');
			return vinext({ appDir: '/' });
		},
		seedRuntime: seedVinextRuntime,
	});
	await runWithHostDevelopmentMode(() => host.build([...SERVER_RUNTIME_EXTERNALS], APP_ROUTER_ENTRY));
	return host;
}

describe('dev module server', () => {
	it('serves a user client component unbundled with Fast Refresh + hot wiring', async () => {
		const host = await buildTemplateHost();
		const context = host.devModuleContext();

		const module = await serveDevelopmentModule(`/@vinext-client/${encodeURIComponent('/app/counter.tsx')}`, context);
		expect(module).toBeDefined();
		const code = module?.code ?? '';
		// React Fast Refresh + import.meta.hot self-accepting boundary.
		expect(code).toContain('__preview_hot__');
		expect(code).toContain('$RefreshReg$(Counter, "Counter")');
		expect(code).toContain('__preview_hot__.accept()');
		// React imports rewritten to the shared dev-dependency URL (single instance),
		// tagged with the runtime cache token so the browser caches it immutably.
		expect(code).toContain('/@vinext-client-dep/react?v=r1');
		expect(code).not.toMatch(/from\s*["']react["']/);
	}, 180_000);

	it('re-exports React from the runtime global (single shared instance)', async () => {
		const host = await buildTemplateHost();
		const context = host.devModuleContext();

		const reactModule = await serveDevelopmentModule(`/@vinext-client-dep/${encodeURIComponent('react')}`, context);
		expect(reactModule?.contentType).toBe('application/javascript');
		// React is not re-bundled — it re-exports the runtime's shared instance.
		expect(reactModule?.code).toContain('globalThis.__vinext_react');
		expect(reactModule?.code).toContain('export const { ');
		expect(reactModule?.code).toContain('useState');

		const jsxRuntime = await serveDevelopmentModule(`/@vinext-client-dep/${encodeURIComponent('react/jsx-runtime')}`, context);
		expect(jsxRuntime?.code).toContain('globalThis.__vinext_jsx_runtime');
		expect(jsxRuntime?.code).toContain('Fragment');
	}, 180_000);

	it('exposes the runtime React on globals from the client entry', async () => {
		const host = await buildTemplateHost();
		const clientEntry = host.readOutput('/dist/client')['index.js'] ?? '';
		expect(clientEntry).toContain('globalThis.__vinext_react');
		expect(clientEntry).toContain('globalThis.__vinext_jsx_runtime');
	}, 180_000);
});
