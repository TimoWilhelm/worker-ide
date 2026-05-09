import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { MCP_SERVERS } from '@shared/constants';

import { isRecordObject } from './utilities';

export class McpClientManager {
	private clients = new Map<string, Client>();
	private async getClient(serverId: string): Promise<Client> {
		const existing = this.clients.get(serverId);
		if (existing) return existing;

		const serverConfig = MCP_SERVERS.find((server) => server.id === serverId);
		if (!serverConfig) {
			throw new Error(`Unknown MCP server: ${serverId}`);
		}

		const client = new Client({ name: 'worker-ide-agent', version: '1.0.0' });
		const transport = new StreamableHTTPClientTransport(new URL(serverConfig.endpoint));
		await client.connect(transport);

		this.clients.set(serverId, client);
		return client;
	}
	async callTool(serverId: string, toolName: string, arguments_: Record<string, unknown>): Promise<string> {
		const client = await this.getClient(serverId);
		const result = await client.callTool({ name: toolName, arguments: arguments_ });

		if (result.content && Array.isArray(result.content)) {
			const textParts: string[] = [];
			for (const item of result.content) {
				if (isRecordObject(item) && item.type === 'text' && typeof item.text === 'string') {
					textParts.push(item.text);
				}
			}
			if (textParts.length > 0) {
				return textParts.join('\n');
			}
		}

		return JSON.stringify(result.content);
	}
	async closeAll(): Promise<void> {
		for (const [serverId, client] of this.clients) {
			try {
				await client.close();
			} catch {
				// No-op
			}
			this.clients.delete(serverId);
		}
	}
}
