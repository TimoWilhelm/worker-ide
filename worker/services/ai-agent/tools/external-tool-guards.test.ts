import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockContext, createMockSendEvent } from './test-helpers';

const mockCreateExecuteTool = vi.fn();
const mockBrowserExecute = vi.fn(async ({ code }: { code: string }) => code);

vi.mock('cloudflare:workers', () => ({
	env: {
		PREVIEW_SECRET: 'test-preview-secret',
	},
}));

vi.mock('@cloudflare/think/tools/execute', () => ({
	createExecuteTool: (...arguments_: Parameters<typeof mockCreateExecuteTool>) => {
		mockCreateExecuteTool(...arguments_);
		return { execute: vi.fn() };
	},
}));

vi.mock('@cloudflare/think/tools/browser', () => ({
	createBrowserTools: () => ({
		browser_search: { description: 'search', inputSchema: {}, execute: vi.fn(async () => 'search') },
		browser_execute: { description: 'execute', inputSchema: {}, execute: mockBrowserExecute },
	}),
}));

const { createServerTools } = await import('./index');

function createLoader(): WorkerLoader {
	return {
		get: vi.fn(() => ({ fetch: vi.fn() })),
		load: vi.fn(() => ({ fetch: vi.fn() })),
	};
}

function createBrowserFetcher(): Fetcher {
	return {
		fetch: vi.fn(async () => new Response('ok')),
	};
}

describe('createServerTools external guards', () => {
	beforeEach(() => {
		mockCreateExecuteTool.mockReset();
		mockBrowserExecute.mockClear();
	});

	it('sets execute to explicit no-network mode', async () => {
		await createServerTools(
			createMockSendEvent(),
			createMockContext({
				loader: createLoader(),
				browser: createBrowserFetcher(),
				requestOriginContext: { baseDomain: 'example.com', protocol: 'https:' },
			}),
			[],
			'code',
		);

		// eslint-disable-next-line unicorn/no-null -- createExecuteTool uses null to disable sandbox outbound network access
		expect(mockCreateExecuteTool).toHaveBeenCalledWith(expect.objectContaining({ globalOutbound: null }));
	});

	it('only exposes browser_execute in code mode with request origin context', async () => {
		const tools = await createServerTools(
			createMockSendEvent(),
			createMockContext({
				loader: createLoader(),
				browser: createBrowserFetcher(),
				requestOriginContext: { baseDomain: 'example.com', protocol: 'https:' },
			}),
			[],
			'code',
		);

		expect(tools).toHaveProperty('browser_execute');
		const browserExecuteTool = tools.browser_execute;
		if (
			!browserExecuteTool ||
			typeof browserExecuteTool !== 'object' ||
			!('execute' in browserExecuteTool) ||
			typeof browserExecuteTool.execute !== 'function'
		) {
			throw new Error('browser_execute tool was not created');
		}
		await browserExecuteTool.execute({ code: 'async () => cdp.send("Page.navigate", { url: "/docs" })' });
		expect(mockBrowserExecute).toHaveBeenCalledWith(
			expect.objectContaining({ code: expect.stringContaining("project's preview origin") }),
			undefined,
		);
	});

	it('omits browser_execute outside code mode', async () => {
		const tools = await createServerTools(
			createMockSendEvent(),
			createMockContext({
				loader: createLoader(),
				browser: createBrowserFetcher(),
				requestOriginContext: { baseDomain: 'example.com', protocol: 'https:' },
			}),
			[],
			'plan',
		);

		expect(tools).not.toHaveProperty('browser_execute');
		expect(tools).toHaveProperty('browser_search');
	});
});
