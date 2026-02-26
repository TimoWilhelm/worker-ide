/**
 * Tool: docs_search
 * Search the Cloudflare documentation.
 */

import { ToolExecutionError } from '@shared/tool-errors';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const DESCRIPTION = `Search the Cloudflare documentation for information about Cloudflare products and features including Workers, Pages, R2, D1, KV, Durable Objects, Queues, AI, Zero Trust, DNS, CDN, and more.

Usage:
- Prefer this tool over web_fetch when looking up Cloudflare-specific information.
- Use a specific, focused query for best results.
- Returns relevant documentation chunks from the Cloudflare docs.
- Useful when you need to look up API details, configuration options, or best practices.`;

export const definition: ToolDefinition = {
	name: 'docs_search',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Search query for Cloudflare documentation' },
		},
		required: ['query'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const query = input.query;
	await sendEvent('status', { message: `Searching Cloudflare docs: "${query}"...` });

	try {
		const result = await context.callMcpTool('cloudflare-docs', 'search_cloudflare_documentation', { query });
		return { title: query, metadata: { query }, output: typeof result === 'string' ? result : JSON.stringify(result) };
	} catch (error) {
		throw new ToolExecutionError('MISSING_INPUT', `Cloudflare docs search failed: ${String(error)}`);
	}
}
