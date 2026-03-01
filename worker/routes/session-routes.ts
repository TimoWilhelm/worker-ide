/**
 * AI session management routes.
 * Handles CRUD operations for AI chat sessions.
 *
 * All session and pending-changes data is stored in the AgentRunner
 * Durable Object (DO storage is the source of truth).
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { sessionIdSchema, pendingChangesFileSchema } from '@shared/validation';

import { agentRunnerNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';

import type { AppEnvironment } from '../types';

/**
 * Get the AgentRunner stub for a project.
 */
function getAgentRunnerStub(projectId: string) {
	const id = agentRunnerNamespace.idFromName(`agent:${projectId}`);
	return agentRunnerNamespace.get(id);
}

/**
 * Session routes - all routes are prefixed with /api
 */
export const sessionRoutes = new Hono<AppEnvironment>()
	// GET /api/ai-sessions - List all saved AI sessions
	.get('/ai-sessions', async (c) => {
		const projectId = c.get('projectId');
		const stub = getAgentRunnerStub(projectId);
		const rpcSessions = await stub.listSessions();
		// Map explicitly to restore the proper typed array after DO RPC
		// serialization (which loses exact array methods and field types).
		const sessions = rpcSessions.map((session) => ({
			id: session.id,
			title: session.title,
			createdAt: session.createdAt,
			isRunning: session.isRunning,
		}));
		return c.json({ sessions });
	})

	// GET /api/ai-session?id=X - Load a single AI session
	.get('/ai-session', zValidator('query', z.object({ id: sessionIdSchema })), async (c) => {
		const projectId = c.get('projectId');
		const { id } = c.req.valid('query');
		const stub = getAgentRunnerStub(projectId);
		const session = await stub.loadSession(id);
		if (!session) {
			throw httpError(404, 'Session not found');
		}
		return c.json(session);
	})

	// POST /api/ai-session/revert - Revert a session to a given message index
	.post(
		'/ai-session/revert',
		zValidator('json', z.object({ id: sessionIdSchema, messageIndex: z.number().int().nonnegative() })),
		async (c) => {
			const projectId = c.get('projectId');
			const { id, messageIndex } = c.req.valid('json');
			const stub = getAgentRunnerStub(projectId);
			await stub.revertSession(id, messageIndex);
			return c.json({ success: true });
		},
	)

	// DELETE /api/ai-session?id=X - Delete an AI session
	.delete('/ai-session', zValidator('query', z.object({ id: sessionIdSchema })), async (c) => {
		const projectId = c.get('projectId');
		const { id } = c.req.valid('query');
		const stub = getAgentRunnerStub(projectId);
		await stub.deleteSession(projectId, id);
		return c.json({ success: true });
	})

	// GET /api/pending-changes - Load project-level pending changes
	.get('/pending-changes', async (c) => {
		const projectId = c.get('projectId');
		const stub = getAgentRunnerStub(projectId);
		const changes = await stub.loadPendingChanges();
		return c.json(changes);
	})

	// PUT /api/pending-changes - Save project-level pending changes
	.put('/pending-changes', zValidator('json', pendingChangesFileSchema), async (c) => {
		const projectId = c.get('projectId');
		const body = c.req.valid('json');

		// Strip non-pending entries before writing
		const filtered: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(body)) {
			if (value.status === 'pending') {
				filtered[key] = value;
			}
		}

		const stub = getAgentRunnerStub(projectId);
		await stub.savePendingChanges(filtered);
		return c.json({ success: true });
	});

export type SessionRoutes = typeof sessionRoutes;
