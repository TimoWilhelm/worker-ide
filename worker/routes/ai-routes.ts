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

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { convertMessagesToModelMessages } from '@tanstack/ai';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { z } from 'zod';

import { DEFAULT_AI_MODEL } from '@shared/constants';
import { aiChatMessageSchema, debugLogIdSchema } from '@shared/validation';

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

		const { messages, mode, sessionId, model, outputLogs } = c.req.valid('json');

		// Convert UIMessage[] (from frontend) to ModelMessage[] (for the adapter)
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- UIMessage format from frontend is loosely typed at the wire boundary
		const modelMessages = convertMessagesToModelMessages(messages as any);

		// Use the validated model from the request, or fall back to the default
		const selectedModel = model ?? DEFAULT_AI_MODEL;

		const agentService = new AIAgentService(projectRoot, projectId, fsStub, sessionId, mode, selectedModel);
		const response = await agentService.runAgentChat(modelMessages, apiToken, c.req.raw.signal, outputLogs);

		return response;
	})

	// POST /api/ai/abort - Abort current AI chat (handled via request signal)
	.post('/ai/abort', async (c) => {
		// The abort is handled via the AbortController signal in the browser
		// This endpoint exists for explicit abort requests if needed
		return c.json({ success: true });
	})

	// GET /api/ai/debug-log/latest - Get the most recent debug log ID
	.get('/ai/debug-log/latest', async (c) => {
		const projectRoot = c.get('projectRoot');
		const logsDirectory = `${projectRoot}/.agent/debug-logs`;

		try {
			const entries = await fs.readdir(logsDirectory);
			const logFiles = entries
				.filter((entry) => entry.endsWith('.json'))
				.toSorted((a, b) => {
					const timestampA = Number(a.slice(0, -5).split('-').pop()) || 0;
					const timestampB = Number(b.slice(0, -5).split('-').pop()) || 0;
					return timestampA - timestampB;
				});

			const latest = logFiles.at(-1);
			if (!latest) {
				return c.json({ id: undefined });
			}

			// Strip the .json extension to get the log ID
			const id = latest.slice(0, -5);
			return c.json({ id });
		} catch {
			return c.json({ id: undefined });
		}
	})

	// GET /api/ai/debug-log?id=X - Download an agent debug log
	.get('/ai/debug-log', zValidator('query', z.object({ id: debugLogIdSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { id } = c.req.valid('query');

		const logPath = `${projectRoot}/.agent/debug-logs/${id}.json`;
		try {
			const content = await fs.readFile(logPath, 'utf8');
			return c.json(JSON.parse(content));
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
				return c.json({ error: 'Debug log not found' }, 404);
			}
			return c.json({ error: 'Failed to read debug log' }, 500);
		}
	});

export type AIRoutes = typeof aiRoutes;
