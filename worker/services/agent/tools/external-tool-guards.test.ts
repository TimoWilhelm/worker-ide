import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockContext, createMockSendEvent } from './test-helpers';

import type { BrowserBinding } from '../types';

const mockCreateExecuteTool = vi.fn();
const mockBrowserExecute = vi.fn(async ({ code }: { code: string }) => code);
const mockBrowserMarkdown = vi.fn(async (_input: { url?: string; html?: string }) => 'markdown');

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
		browser_markdown: { description: 'markdown', inputSchema: {}, execute: mockBrowserMarkdown },
		browser_extract: { description: 'extract', inputSchema: {}, execute: vi.fn(async () => 'extract') },
		browser_links: { description: 'links', inputSchema: {}, execute: vi.fn(async () => 'links') },
		browser_scrape: { description: 'scrape', inputSchema: {}, execute: vi.fn(async () => 'scrape') },
		browser_execute: { description: 'execute', inputSchema: {}, execute: mockBrowserExecute },
	}),
}));

const { createServerTools } = await import('./index');

function createMockDurableObjectState(): DurableObjectState {
	return {} as DurableObjectState;
}

function createLoader(): WorkerLoader {
	return {
		get: vi.fn(() => ({ fetch: vi.fn() })),
		load: vi.fn(() => ({ fetch: vi.fn() })),
	};
}

function createBrowserFetcher(): BrowserBinding {
	return {
		fetch: vi.fn(async () => new Response('ok')),
	};
}

describe('createServerTools external guards', () => {
	beforeEach(() => {
		mockCreateExecuteTool.mockReset();
		mockBrowserExecute.mockClear();
		mockBrowserMarkdown.mockClear();
	});

	it('sets execute to explicit no-network mode and passes the DO ctx', async () => {
		await createServerTools(
			createMockSendEvent(),
			createMockContext({
				ctx: createMockDurableObjectState(),
				loader: createLoader(),
				browser: createBrowserFetcher(),
				requestOriginContext: { baseDomain: 'example.com', protocol: 'https:' },
			}),
			[],
			'code',
		);

		expect(mockCreateExecuteTool).toHaveBeenCalledWith(
			// eslint-disable-next-line unicorn/no-null -- createExecuteTool uses null to disable sandbox outbound network access
			expect.objectContaining({ globalOutbound: null, ctx: expect.anything() }),
		);
	});

	it('only exposes browser_execute in code mode with request origin context', async () => {
		const tools = await createServerTools(
			createMockSendEvent(),
			createMockContext({
				ctx: createMockDurableObjectState(),
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

	it('exposes quick action tools and omits browser_execute outside code mode', async () => {
		const tools = await createServerTools(
			createMockSendEvent(),
			createMockContext({
				ctx: createMockDurableObjectState(),
				loader: createLoader(),
				browser: createBrowserFetcher(),
				requestOriginContext: { baseDomain: 'example.com', protocol: 'https:' },
			}),
			[],
			'plan',
		);

		expect(tools).not.toHaveProperty('browser_execute');
		expect(tools).toHaveProperty('browser_markdown');
		expect(tools).toHaveProperty('browser_extract');
		expect(tools).toHaveProperty('browser_links');
		expect(tools).toHaveProperty('browser_scrape');
	});

	it('restricts quick action tool URLs to the project preview origin', async () => {
		const tools = await createServerTools(
			createMockSendEvent(),
			createMockContext({
				ctx: createMockDurableObjectState(),
				loader: createLoader(),
				browser: createBrowserFetcher(),
				requestOriginContext: { baseDomain: 'example.com', protocol: 'https:' },
			}),
			[],
			'code',
		);

		const markdownTool = tools.browser_markdown;
		if (!markdownTool || typeof markdownTool !== 'object' || !('execute' in markdownTool) || typeof markdownTool.execute !== 'function') {
			throw new Error('browser_markdown tool was not created');
		}

		await expect(markdownTool.execute({ url: 'https://evil.example.net/' })).rejects.toThrow(/preview origin/);
		expect(mockBrowserMarkdown).not.toHaveBeenCalled();
	});
});
