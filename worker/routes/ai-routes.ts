/**
 * AI Agent routes.
 * Handles AI chat and session management.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { aiChatMessageSchema } from '@shared/validation';

import { AIAgentService } from '../services/ai-agent-service';

import type { AppEnvironment } from '../types';

/**
 * AI routes - all routes are prefixed with /api
 */
export const aiRoutes = new Hono<AppEnvironment>()
	// POST /api/ai/chat - Start AI chat with streaming response
	.post('/ai/chat', zValidator('json', aiChatMessageSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const environment = c.env;

		const apiToken = environment.REPLICATE_API_TOKEN;
		if (!apiToken) {
			return c.json(
				{
					error: 'REPLICATE_API_TOKEN not configured. Please set it using: wrangler secret put REPLICATE_API_TOKEN',
				},
				500,
			);
		}

		// Rate limit check
		if (environment.REPLICATE_RATE_LIMITER) {
			const { success } = await environment.REPLICATE_RATE_LIMITER.limit({ key: projectId });
			if (!success) {
				return c.json(
					{
						error: 'Rate limit exceeded. Please wait before making more AI requests.',
						code: 'RATE_LIMIT_EXCEEDED',
					},
					429,
				);
			}
		}

		const { message, history = [] } = c.req.valid('json');

		const agentService = new AIAgentService(projectRoot, projectId, environment);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const chatHistory: any[] = history;
		const stream = await agentService.runAgentChat(message, chatHistory, apiToken, c.req.raw.signal);

		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
				'Access-Control-Allow-Origin': '*',
			},
		});
	})

	// POST /api/ai/abort - Abort current AI chat (handled via request signal)
	.post('/ai/abort', async (c) => {
		// The abort is handled via the AbortController signal in the browser
		// This endpoint exists for explicit abort requests if needed
		return c.json({ success: true });
	});

export type AIRoutes = typeof aiRoutes;
