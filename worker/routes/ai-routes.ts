/**
 * AI Agent routes.
 * Handles AI chat, abort, status, and debug log endpoints.
 *
 * The chat endpoint delegates to the AgentRunner Durable Object which
 * executes the agent loop independently of client connections. Stream
 * events are broadcast to clients via WebSocket through the ProjectCoordinator.
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { z } from 'zod';

import { aiChatMessageSchema, debugLogIdSchema } from '@shared/validation';

import { agentRunnerNamespace } from '../lib/durable-object-namespaces';

import type { AppEnvironment } from '../types';

/**
 * AI routes - all routes are prefixed with /api
 */
export const aiRoutes = new Hono<AppEnvironment>()
	// POST /api/ai/chat - Start AI agent run (delegated to AgentRunner DO)
	.post('/ai/chat', zValidator('json', aiChatMessageSchema), async (c) => {
		const projectId = c.get('projectId');

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

		// Delegate to the AgentRunner DO which runs the agent loop
		// independently of this HTTP request lifecycle.
		const agentRunnerId = agentRunnerNamespace.idFromName(`agent:${projectId}`);
		const agentRunnerStub = agentRunnerNamespace.get(agentRunnerId);

		const session = await agentRunnerStub.startAgent({
			messages,
			mode,
			sessionId,
			model,
			outputLogs,
		});

		return c.json({ sessionId: session.sessionId, status: session.status });
	})

	// POST /api/ai/abort - Abort current AI agent run
	.post('/ai/abort', async (c) => {
		const projectId = c.get('projectId');

		const agentRunnerId = agentRunnerNamespace.idFromName(`agent:${projectId}`);
		const agentRunnerStub = agentRunnerNamespace.get(agentRunnerId);
		await agentRunnerStub.abortAgent();

		return c.json({ success: true });
	})

	// GET /api/ai/agent-status - Get current agent status
	.get('/ai/agent-status', async (c) => {
		const projectId = c.get('projectId');

		const agentRunnerId = agentRunnerNamespace.idFromName(`agent:${projectId}`);
		const agentRunnerStub = agentRunnerNamespace.get(agentRunnerId);
		const status = await agentRunnerStub.getAgentStatus();

		return c.json({ session: status ?? undefined });
	})

	// GET /api/ai/latest-debug-log-id?sessionId=X - Get the latest debug log ID for a session
	.get('/ai/latest-debug-log-id', zValidator('query', z.object({ sessionId: z.string().min(1) })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { sessionId } = c.req.valid('query');
		const logsDirectory = `${projectRoot}/.agent/sessions/${sessionId}/debug-logs`;

		try {
			const entries = await fs.readdir(logsDirectory);
			const logFiles = entries
				.filter((entry) => entry.endsWith('.json'))
				.toSorted((a, b) => {
					// Log files are named {prefix}-{timestamp}.json — sort by the numeric timestamp suffix.
					const timestampA = Number(a.slice(0, -5).split('-').pop()) || 0;
					const timestampB = Number(b.slice(0, -5).split('-').pop()) || 0;
					return timestampA - timestampB;
				});

			if (logFiles.length === 0) {
				return c.json({ id: '' });
			}

			// Return the latest log file's ID (filename without .json extension)
			const latestFile = logFiles.at(-1)!;
			return c.json({ id: latestFile.slice(0, -5) });
		} catch {
			return c.json({ id: '' });
		}
	})

	// GET /api/ai/debug-log?id=X&sessionId=Y - Download an agent debug log
	.get('/ai/debug-log', zValidator('query', z.object({ id: debugLogIdSchema, sessionId: z.string().min(1).optional() })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { id, sessionId } = c.req.valid('query');

		// Debug logs are stored alongside sessions when a sessionId is available
		const logPath = sessionId
			? `${projectRoot}/.agent/sessions/${sessionId}/debug-logs/${id}.json`
			: `${projectRoot}/.agent/debug-logs/${id}.json`;
		let content: string;
		try {
			content = await fs.readFile(logPath, 'utf8');
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
				return c.json({ error: 'Debug log not found' }, 404);
			}
			console.error('Failed to read debug log file:', error);
			return c.json({ error: 'Failed to read debug log' }, 500);
		}

		// Validate JSON before returning — corrupted/truncated logs should
		// return a clear error rather than a generic 500.
		try {
			JSON.parse(content);
		} catch {
			console.error(`Debug log file contains invalid JSON: ${logPath}`);
			return c.json({ error: 'Debug log file is corrupted' }, 422);
		}

		return c.body(content, 200, { 'Content-Type': 'application/json' });
	});

export type AIRoutes = typeof aiRoutes;
