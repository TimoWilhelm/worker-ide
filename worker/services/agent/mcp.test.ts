import { describe, expect, it, vi } from 'vitest';

import { MCP_SERVERS } from '@shared/constants';

import { callConfiguredMcpTool, createConfiguredMcpConnectors, registerConfiguredMcpServers } from './mcp';

import type { Agent } from 'agents';

function createAgent(overrides?: Record<string, unknown>): Agent<Env, unknown> {
	return {
		addMcpServer: vi.fn(),
		mcp: {
			waitForConnections: vi.fn(),
			listServers: vi.fn(() => []),
			mcpConnections: {},
		},
		...overrides,
	} as unknown as Agent<Env, unknown>;
}

describe('configured MCP servers', () => {
	it('registers each server with its stable ID', async () => {
		const addMcpServer = vi.fn();
		const agent = createAgent({ addMcpServer });

		await registerConfiguredMcpServers(agent);

		for (const server of MCP_SERVERS) {
			expect(addMcpServer).toHaveBeenCalledWith(server.name, server.endpoint, { id: server.id });
		}
	});

	it('creates a named connector from a restored connection', async () => {
		const waitForConnections = vi.fn();
		const connection = { client: { callTool: vi.fn() }, tools: [] };
		const agent = createAgent({
			mcp: {
				waitForConnections,
				listServers: vi.fn(() => [{ id: 'cloudflare-docs' }]),
				mcpConnections: { 'cloudflare-docs': connection },
			},
		});

		const connectors = await createConfiguredMcpConnectors(agent, {} as DurableObjectState, {} as Env);

		expect(waitForConnections).toHaveBeenCalledWith();
		expect(connectors).toHaveLength(1);
		expect(connectors[0]?.name()).toBe('cloudflare_docs');
	});

	it('calls a tool through the restored Agents SDK connection', async () => {
		const callTool = vi.fn().mockResolvedValue({
			content: [
				{ type: 'text', text: 'first result' },
				{ type: 'text', text: 'second result' },
			],
		});
		const waitForConnections = vi.fn();
		const agent = createAgent({
			mcp: {
				waitForConnections,
				listServers: vi.fn(),
				mcpConnections: { 'cloudflare-docs': { client: { callTool } } },
			},
		});

		const result = await callConfiguredMcpTool(agent, 'cloudflare-docs', 'search_cloudflare_documentation', {
			query: 'Durable Objects',
		});

		expect(waitForConnections).toHaveBeenCalledWith();
		expect(callTool).toHaveBeenCalledWith({
			name: 'search_cloudflare_documentation',
			arguments: { query: 'Durable Objects' },
		});
		expect(result).toBe('first result\nsecond result');
	});
});
