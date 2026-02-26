/**
 * Integration tests for the docs_search tool.
 *
 * Tests MCP tool delegation, result formatting, and error handling.
 * The callMcpTool context method is mocked since MCP servers
 * are not available in the test environment.
 */

import { describe, expect, it, vi } from 'vitest';

import { execute } from './documentation-search';
import { createMockContext, createMockSendEvent } from './test-helpers';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docs_search', () => {
	// ── Successful search ─────────────────────────────────────────────────

	it('returns results from MCP tool', async () => {
		const mockCallMcpTool = vi.fn().mockResolvedValue('Workers AI documentation...');
		const context = createMockContext({ callMcpTool: mockCallMcpTool });

		const result = await execute({ query: 'Workers AI' }, createMockSendEvent(), context);

		expect(result.output).toBe('Workers AI documentation...');
		expect(result.metadata).toHaveProperty('query', 'Workers AI');
		expect(mockCallMcpTool).toHaveBeenCalledWith('cloudflare-docs', 'search_cloudflare_documentation', { query: 'Workers AI' });
	});

	// ── MCP tool failure ──────────────────────────────────────────────────

	it('throws error when MCP tool throws', async () => {
		const mockCallMcpTool = vi.fn().mockRejectedValue(new Error('MCP server unavailable'));
		const context = createMockContext({ callMcpTool: mockCallMcpTool });

		await expect(execute({ query: 'D1 database' }, createMockSendEvent(), context)).rejects.toThrow('Cloudflare docs search failed');
	});

	// ���─ Status event ──────────────────────────────────────────────────────

	it('sends status event with search query', async () => {
		const sendEvent = createMockSendEvent();
		const context = createMockContext({
			callMcpTool: vi.fn().mockResolvedValue('results'),
		});

		await execute({ query: 'R2 storage' }, sendEvent, context);

		const statusEvent = sendEvent.calls.find(([type]) => type === 'status');
		expect(statusEvent).toBeDefined();
		expect(statusEvent![1]).toHaveProperty('message');
		const message = statusEvent![1].message as string;
		expect(message).toContain('R2 storage');
	});

	// ── Query is passed through correctly ─────────────────────────────────

	it('passes query argument correctly to MCP tool', async () => {
		const mockCallMcpTool = vi.fn().mockResolvedValue('result');
		const context = createMockContext({ callMcpTool: mockCallMcpTool });

		await execute({ query: 'Durable Objects hibernation API' }, createMockSendEvent(), context);

		expect(mockCallMcpTool).toHaveBeenCalledWith('cloudflare-docs', 'search_cloudflare_documentation', {
			query: 'Durable Objects hibernation API',
		});
	});
});
