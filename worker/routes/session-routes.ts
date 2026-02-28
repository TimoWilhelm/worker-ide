/**
 * AI session management routes.
 * Handles CRUD operations for AI chat sessions.
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { sessionIdSchema, saveSessionSchema, pendingChangesFileSchema } from '@shared/validation';

import { httpError } from '../lib/http-error';

const sessionIdQuerySchema = z.object({ id: sessionIdSchema });

import type { AppEnvironment } from '../types';

/**
 * Session routes - all routes are prefixed with /api
 */
export const sessionRoutes = new Hono<AppEnvironment>()
	// GET /api/ai-sessions - List all saved AI sessions
	.get('/ai-sessions', async (c) => {
		const projectRoot = c.get('projectRoot');
		const sessionsDirectory = `${projectRoot}/.agent/sessions`;
		try {
			const entries = await fs.readdir(sessionsDirectory);
			const sessions: Array<{ id: string; title: string; createdAt: number }> = [];

			for (const name of entries) {
				if (!name.endsWith('.json')) continue;
				try {
					const raw = await fs.readFile(`${sessionsDirectory}/${name}`, 'utf8');
					const session: { id: string; title: string; createdAt: number } = JSON.parse(raw);
					sessions.push({ id: session.id, title: session.title, createdAt: session.createdAt });
				} catch {
					// Skip invalid session files
				}
			}

			sessions.sort((a, b) => b.createdAt - a.createdAt);
			return c.json({ sessions: sessions.slice(0, 100) });
		} catch {
			return c.json({ sessions: [] });
		}
	})

	// GET /api/ai-session?id=X - Load a single AI session
	.get('/ai-session', zValidator('query', sessionIdQuerySchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { id } = c.req.valid('query');

		try {
			const raw = await fs.readFile(`${projectRoot}/.agent/sessions/${id}.json`, 'utf8');
			return c.json(JSON.parse(raw));
		} catch {
			throw httpError(404, 'Session not found');
		}
	})

	// PUT /api/ai-session - Save an AI session
	.put('/ai-session', zValidator('json', saveSessionSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const body = c.req.valid('json');

		const sessionsDirectory = `${projectRoot}/.agent/sessions`;
		await fs.mkdir(sessionsDirectory, { recursive: true });
		await fs.writeFile(`${sessionsDirectory}/${body.id}.json`, JSON.stringify(body));

		return c.json({ success: true });
	})

	// POST /api/ai-session - Save an AI session (for sendBeacon)
	.post('/ai-session', zValidator('json', saveSessionSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const body = c.req.valid('json');

		const sessionsDirectory = `${projectRoot}/.agent/sessions`;
		await fs.mkdir(sessionsDirectory, { recursive: true });
		await fs.writeFile(`${sessionsDirectory}/${body.id}.json`, JSON.stringify(body));

		return c.json({ success: true });
	})

	// DELETE /api/ai-session?id=X - Delete an AI session
	.delete('/ai-session', zValidator('query', sessionIdQuerySchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { id } = c.req.valid('query');

		try {
			await fs.unlink(`${projectRoot}/.agent/sessions/${id}.json`);
		} catch {
			// Ignore errors if file doesn't exist
		}
		return c.json({ success: true });
	})

	// GET /api/pending-changes - Load project-level pending changes
	.get('/pending-changes', async (c) => {
		const projectRoot = c.get('projectRoot');
		const pendingChangesPath = `${projectRoot}/.agent/pending-changes.json`;

		try {
			const raw = await fs.readFile(pendingChangesPath, 'utf8');
			return c.json(JSON.parse(raw));
		} catch {
			return c.json({});
		}
	})

	// PUT /api/pending-changes - Save project-level pending changes
	.put('/pending-changes', zValidator('json', pendingChangesFileSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const body = c.req.valid('json');

		// Strip non-pending entries before writing
		const filtered: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(body)) {
			if (value.status === 'pending') {
				filtered[key] = value;
			}
		}

		const agentDirectory = `${projectRoot}/.agent`;
		await fs.mkdir(agentDirectory, { recursive: true });
		await fs.writeFile(`${agentDirectory}/pending-changes.json`, JSON.stringify(filtered));

		return c.json({ success: true });
	});

export type SessionRoutes = typeof sessionRoutes;
