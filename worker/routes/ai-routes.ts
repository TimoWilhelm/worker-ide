/**
 * AI Agent routes.
 * Handles AI chat and session management.
 *
 * The chat endpoint accepts the TanStack AI fetchServerSentEvents format:
 * POST body: { messages: UIMessage[], data?: {...}, mode?, sessionId?, model? }
 *
 * Messages are converted from UIMessage[] to ModelMessage[] using TanStack AI's
 * convertMessagesToModelMessages() utility.
 */

import { zValidator } from '@hono/zod-validator';
import { convertMessagesToModelMessages } from '@tanstack/ai';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';

import { DEFAULT_AI_MODEL } from '@shared/constants';
import { aiChatMessageSchema } from '@shared/validation';

import { AIAgentService } from '../services/ai-agent';

import type { AppEnvironment } from '../types';

/**
 * AI routes - all routes are prefixed with /api
 */
export const aiRoutes = new Hono<AppEnvironment>()
	// POST /api/ai/chat - Start AI chat with streaming response
	.post('/ai/chat', zValidator('json', aiChatMessageSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const fsStub = c.get('fsStub');

		const apiToken = env.REPLICATE_API_TOKEN;
		if (!apiToken) {
			return c.json(
				{
					error: 'REPLICATE_API_TOKEN not configured. Please set it using: wrangler secret put REPLICATE_API_TOKEN',
				},
				500,
			);
		}

		// Rate limit check
		if (env.AI_RATE_LIMITER) {
			const { success } = await env.AI_RATE_LIMITER.limit({ key: projectId });
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

		const { messages, mode, sessionId, model } = c.req.valid('json');

		// Convert UIMessage[] (from frontend) to ModelMessage[] (for the adapter)
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- UIMessage format from frontend is loosely typed at the wire boundary
		const modelMessages = convertMessagesToModelMessages(messages as any);

		// Use the validated model from the request, or fall back to the default
		const selectedModel = model ?? DEFAULT_AI_MODEL;

		const agentService = new AIAgentService(projectRoot, projectId, fsStub, sessionId, mode, selectedModel);
		const response = await agentService.runAgentChat(modelMessages, apiToken, c.req.raw.signal);

		return response;
	})

	// POST /api/ai/abort - Abort current AI chat (handled via request signal)
	.post('/ai/abort', async (c) => {
		// The abort is handled via the AbortController signal in the browser
		// This endpoint exists for explicit abort requests if needed
		return c.json({ success: true });
	});

export type AIRoutes = typeof aiRoutes;
