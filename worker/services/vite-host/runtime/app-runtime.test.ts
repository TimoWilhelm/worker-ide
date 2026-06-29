import { describe, expect, it } from 'vitest';

import { routeAppRequest, type ServerFetcher } from './app-runtime';

describe('routeAppRequest', () => {
	it('serves a matching client asset without hitting the server', async () => {
		let serverCalled = false;
		const server: ServerFetcher = {
			fetch: async () => {
				serverCalled = true;
				return new Response('SSR');
			},
		};

		const response = await routeAppRequest(new Request('https://example.com/index.js'), {
			clientOutput: { 'index.js': 'console.log(1)' },
			server,
		});

		expect(serverCalled).toBe(false);
		expect(response.headers.get('Content-Type')).toBe('application/javascript');
		expect(await response.text()).toBe('console.log(1)');
	});

	it('delegates to the server isolate when no client asset matches', async () => {
		const server: ServerFetcher = {
			fetch: async () => new Response('<!DOCTYPE html><h1>page</h1>'),
		};

		const response = await routeAppRequest(new Request('https://example.com/some/route'), {
			clientOutput: { 'index.js': 'console.log(1)' },
			server,
		});

		expect(await response.text()).toContain('<h1>page</h1>');
	});
});
