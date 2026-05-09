import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockGenerateText = vi.hoisted(() => vi.fn(async () => ({ output: { summary: 'Mock summary' } })));

// Mock the global fetch used by web-fetch.ts
const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

// Mock cloudflare:workers env
vi.mock('cloudflare:workers', () => ({
	env: {
		AI: {
			toMarkdown: async (files: Array<{ name: string; blob: Blob }>) => {
				// Simulate AI markdown conversion
				const text = await files[0].blob.text();
				return [{ data: `# Converted\n\n${text}`, format: 'markdown' }];
			},
		},
	},
}));

// Mock Vercel AI SDK generateText to avoid real LLM calls
vi.mock('ai', () => ({
	generateText: mockGenerateText,
	jsonSchema: (schema: unknown) => schema,
	Output: { object: (config: unknown) => config },
}));

// Mock the workers-ai adapter
vi.mock('../workers-ai', () => ({
	createAdapter: () => ({}),
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./web-fetch');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { createMockContext, createMockSendEvent } from './test-helpers';

function makeResponse(body: string, options: { status?: number; contentType?: string; statusText?: string } = {}): Response {
	const { status = 200, contentType = 'text/html', statusText = 'OK' } = options;
	return new Response(body, {
		status,
		statusText,
		headers: { 'content-type': contentType },
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('web_fetch', () => {
	beforeEach(() => {
		mockFetch.mockReset();
		mockGenerateText.mockClear();
	});

	// ── Successful fetch ──────────────────────────────────────────────────

	it('fetches and summarizes HTML content', async () => {
		mockFetch.mockResolvedValue(makeResponse('<html><body>Test page</body></html>'));

		const result = await execute(
			{ url: 'https://example.com', prompt: 'What is this page about?' },
			createMockSendEvent(),
			createMockContext(),
		);

		expect(result.metadata).toHaveProperty('url', 'https://example.com/');
		expect(result.output).toBeDefined();
		expect(result.metadata).toHaveProperty('contentLength');
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it('handles markdown content directly without HTML conversion', async () => {
		mockFetch.mockResolvedValue(makeResponse('# Hello\n\nThis is markdown.', { contentType: 'text/markdown' }));

		const result = await execute({ url: 'https://example.com/doc.md', prompt: 'Summarize' }, createMockSendEvent(), createMockContext());

		expect(result.output).toBeDefined();
	});

	// ── URL validation ────────────────────────────────────────────────────

	it('rejects non-http/https URLs', async () => {
		await expect(
			execute({ url: 'ftp://example.com/file', prompt: 'Get info' }, createMockSendEvent(), createMockContext()),
		).rejects.toThrow('Only http:// and https://');
	});

	it('rejects credentialed URLs', async () => {
		await expect(
			execute({ url: 'https://user:pass@example.com', prompt: 'Get info' }, createMockSendEvent(), createMockContext()),
		).rejects.toThrow('Credentialed URLs');
	});

	it('rejects localhost targets', async () => {
		await expect(execute({ url: 'http://localhost:8787', prompt: 'Get info' }, createMockSendEvent(), createMockContext())).rejects.toThrow(
			'Blocked target host',
		);
	});

	it('follows safe redirects', async () => {
		mockFetch
			.mockResolvedValueOnce(
				new Response('', {
					status: 302,
					headers: { location: 'https://example.com/final' },
				}),
			)
			.mockResolvedValueOnce(makeResponse('# Final destination', { contentType: 'text/markdown' }));

		const result = await execute({ url: 'https://example.com/start', prompt: 'Summarize' }, createMockSendEvent(), createMockContext());

		expect(result.metadata).toHaveProperty('url', 'https://example.com/final');
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it('rejects redirects to blocked targets', async () => {
		mockFetch.mockResolvedValueOnce(
			new Response('', {
				status: 302,
				headers: { location: 'http://127.0.0.1:8787/private' },
			}),
		);

		await expect(
			execute({ url: 'https://example.com/start', prompt: 'Summarize' }, createMockSendEvent(), createMockContext()),
		).rejects.toThrow('Blocked target host');
	});

	// ── HTTP errors ───────────────────────────────────────────────────────

	it('returns error for non-OK HTTP response', async () => {
		mockFetch.mockResolvedValue(makeResponse('Not Found', { status: 404, statusText: 'Not Found' }));

		await expect(
			execute({ url: 'https://example.com/missing', prompt: 'Info' }, createMockSendEvent(), createMockContext()),
		).rejects.toThrow('404');
	});

	// ── Fetch failure ─────────────────────────────────────────────────────

	it('handles fetch network errors', async () => {
		mockFetch.mockRejectedValue(new Error('Network unreachable'));

		await expect(execute({ url: 'https://example.com', prompt: 'Info' }, createMockSendEvent(), createMockContext())).rejects.toThrow(
			'Failed to fetch',
		);
	});

	// ── Invalid URL ───────────────────────────────────────────────────────

	it('returns error for invalid URLs', async () => {
		await expect(execute({ url: 'not-a-valid-url', prompt: 'Info' }, createMockSendEvent(), createMockContext())).rejects.toThrow();
	});

	// ── Status events ─────────────────────────────────────────────────────

	it('sends status events during fetch lifecycle', async () => {
		mockFetch.mockResolvedValue(makeResponse('# Markdown', { contentType: 'text/markdown' }));
		const sendEvent = createMockSendEvent();

		await execute({ url: 'https://example.com', prompt: 'Info' }, sendEvent, createMockContext());

		const statusEvents = sendEvent.calls.filter(([type]) => type === 'status');
		expect(statusEvents.length).toBeGreaterThanOrEqual(2); // Fetching + Summarizing
	});
});
