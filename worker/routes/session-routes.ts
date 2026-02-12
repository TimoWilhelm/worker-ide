/**
 * AI session management routes.
 * Handles CRUD operations for AI chat sessions.
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { sessionIdSchema, saveSessionSchema } from '@shared/validation';

import type { AppEnvironment } from '../types';

/**
 * Session routes - all routes are prefixed with /api
 */
export const sessionRoutes = new Hono<AppEnvironment>()
	// GET /api/ai-sessions - List all saved AI sessions
	.get('/ai-sessions', async (c) => {
		const projectRoot = c.get('projectRoot');
		const sessionsDirectory = `${projectRoot}/.ai-sessions`;
		try {
			const entries = await fs.readdir(sessionsDirectory);
			const sessions: Array<{ id: string; label: string; createdAt: number }> = [];

			for (const name of entries) {
				if (!name.endsWith('.json')) continue;
				try {
					const raw = await fs.readFile(`${sessionsDirectory}/${name}`, 'utf8');
					const session: { id: string; label: string; createdAt: number } = JSON.parse(raw);
					sessions.push({ id: session.id, label: session.label, createdAt: session.createdAt });
				} catch {
					// Skip invalid session files
				}
			}

			sessions.sort((a, b) => b.createdAt - a.createdAt);
			return c.json({ sessions });
		} catch {
			return c.json({ sessions: [] });
		}
	})

	// GET /api/ai-session?id=X - Load a single AI session
	.get(
		'/ai-session',
		zValidator(
			'query',
			sessionIdSchema.transform((id) => ({ id })),
		),
		async (c) => {
			const projectRoot = c.get('projectRoot');
			const { id } = c.req.valid('query');

			try {
				const raw = await fs.readFile(`${projectRoot}/.ai-sessions/${id}.json`, 'utf8');
				return c.json(JSON.parse(raw));
			} catch {
				return c.json({ error: 'Session not found' }, 404);
			}
		},
	)

	// PUT /api/ai-session - Save an AI session
	.put('/ai-session', zValidator('json', saveSessionSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const body = c.req.valid('json');

		const sessionsDirectory = `${projectRoot}/.ai-sessions`;
		await fs.mkdir(sessionsDirectory, { recursive: true });
		await fs.writeFile(`${sessionsDirectory}/${body.id}.json`, JSON.stringify(body));

		return c.json({ success: true });
	})

	// POST /api/ai-session - Save an AI session (for sendBeacon)
	.post('/ai-session', zValidator('json', saveSessionSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const body = c.req.valid('json');

		const sessionsDirectory = `${projectRoot}/.ai-sessions`;
		await fs.mkdir(sessionsDirectory, { recursive: true });
		await fs.writeFile(`${sessionsDirectory}/${body.id}.json`, JSON.stringify(body));

		return c.json({ success: true });
	})

	// DELETE /api/ai-session?id=X - Delete an AI session
	.delete(
		'/ai-session',
		zValidator(
			'query',
			sessionIdSchema.transform((id) => ({ id })),
		),
		async (c) => {
			const projectRoot = c.get('projectRoot');
			const { id } = c.req.valid('query');

			try {
				await fs.unlink(`${projectRoot}/.ai-sessions/${id}.json`);
			} catch {
				// Ignore errors if file doesn't exist
			}
			return c.json({ success: true });
		},
	);

export type SessionRoutes = typeof sessionRoutes;
