import { McpConnector } from '@cloudflare/codemode';

import { MCP_SERVERS } from '@shared/constants';

import { isRecordObject } from './utilities';

import type { CodemodeConnector, McpConnectionLike } from '@cloudflare/codemode';
import type { Agent } from 'agents';

class ConfiguredMcpConnector extends McpConnector<Env> {
	constructor(
		context: DurableObjectState,
		environment: Env,
		private connection: McpConnectionLike,
		private connectorName: string,
		private connectorInstructions: string,
	) {
		super(context, environment);
	}

	override name(): string {
		return this.connectorName;
	}

	protected override instructions(): string {
		return this.connectorInstructions;
	}

	protected override createConnection(): McpConnectionLike {
		return this.connection;
	}
}

export async function registerConfiguredMcpServers(agent: Agent<Env, unknown>): Promise<void> {
	for (const server of MCP_SERVERS) {
		await agent.addMcpServer(server.name, server.endpoint, { id: server.id });
	}
}

export async function createConfiguredMcpConnectors(
	agent: Agent<Env, unknown>,
	context: DurableObjectState,
	environment: Env,
): Promise<CodemodeConnector[]> {
	await agent.mcp.waitForConnections();

	const connectors: CodemodeConnector[] = [];
	for (const serverConfig of MCP_SERVERS) {
		const server = agent.mcp.listServers().find((candidate) => candidate.id === serverConfig.id);
		const connection = server ? agent.mcp.mcpConnections[server.id] : undefined;
		if (!connection) {
			continue;
		}

		connectors.push(new ConfiguredMcpConnector(context, environment, connection, serverConfig.connectorName, serverConfig.instructions));
	}

	return connectors;
}

export async function callConfiguredMcpTool(
	agent: Agent<Env, unknown> | undefined,
	serverId: string,
	toolName: string,
	arguments_: Record<string, unknown>,
): Promise<string> {
	if (!agent) {
		throw new Error('MCP tools require an Agent connection.');
	}

	await agent.mcp.waitForConnections();
	const connection = agent.mcp.mcpConnections[serverId];
	if (!connection) {
		throw new Error(`MCP server is not connected: ${serverId}`);
	}

	const result = await connection.client.callTool({ name: toolName, arguments: arguments_ });
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
