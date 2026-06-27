/**
 * Integration: the shipped vinext starter template must build and render
 * end-to-end through the in-worker Vite Surface Host — including its client
 * component (`app/counter.tsx`, `"use client"`). This guards against the
 * template drifting from what the build host can actually produce.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { routeAppRequest } from './app-runtime';
import { getServerEntrypoint, serverModulesFromOutput } from './loader-runner';
import { SERVER_RUNTIME_EXTERNALS } from './server-externals';
import { getTemplate } from '../../../templates';
import { ViteHost } from '../vite-host';

const APP_ROUTER_ENTRY = '/__vinext__/dist/server/app-router-entry.js';

/** The template's files, re-keyed to the absolute paths the host expects. */
function templateSnapshot(): Record<string, string> {
	const template = getTemplate('vinext');
	if (template === undefined) throw new Error('vinext template is not registered');
	return Object.fromEntries(Object.entries(template.files).map(([path, contents]) => [`/${path}`, contents]));
}

describe('vinext starter template', () => {
	it('builds and renders the App Router template with a client component', async () => {
		const host = await ViteHost.create({
			files: templateSnapshot(),
			root: '/',
			command: 'build',
			mode: 'production',
			createPlugins: async () => {
				const { vinext } = await import('../../../../auxiliary/vite-host/vendor/native-plugins.mjs');
				return vinext();
			},
		});
		await host.build([...SERVER_RUNTIME_EXTERNALS], APP_ROUTER_ENTRY);

		const server = getServerEntrypoint({
			loader: env.LOADER,
			cacheKey: `vinext-template:${Date.now()}`,
			moduleSet: {
				compatibilityDate: '2025-06-01',
				compatibilityFlags: ['nodejs_compat', 'enable_nodejs_fs_module'],
				mainModule: 'index.js',
				modules: serverModulesFromOutput(host.readOutput('/dist/server')),
			},
		});
		const sources = { clientOutput: host.readOutput('/dist/client'), server };

		const response = await routeAppRequest(new Request('https://example.com/'), sources);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).not.toContain('__next_error__');
		// The server page (RSC) renders to HTML.
		expect(body).toContain('<h1>Hello vinext</h1>');
		// The client component is server-rendered into the HTML too.
		expect(body).toContain('Count:');

		// The client bundle is served as a static asset.
		const clientEntry = await routeAppRequest(new Request('https://example.com/index.js'), sources);
		expect(clientEntry.status).toBe(200);
		expect(clientEntry.headers.get('Content-Type')).toBe('application/javascript');
	}, 180_000);
});
