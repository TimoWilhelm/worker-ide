/**
 * AI Agent routes.
 *
 * Most AI operations (startRun, abortRun, loadSession, etc.) are handled
 * via Agent SDK @callable RPC over WebSocket. These HTTP routes serve only
 * debug log file downloads which are better suited to HTTP (binary content).
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { HttpErrorCode } from '@shared/http-errors';
import { debugLogIdSchema } from '@shared/validation';

import { httpError } from '../lib/http-error';

import type { AppEnvironment } from '../types';

/**
 * AI routes - all routes are prefixed with /api
 */
export const aiRoutes = new Hono<AppEnvironment>()
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
					const timestampA = Number(a.slice(0, -5).split('-').pop()) || 0;
					const timestampB = Number(b.slice(0, -5).split('-').pop()) || 0;
					return timestampA - timestampB;
				});

			if (logFiles.length === 0) {
				return c.json({ id: '' });
			}

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

		const logPath = sessionId
			? `${projectRoot}/.agent/sessions/${sessionId}/debug-logs/${id}.json`
			: `${projectRoot}/.agent/debug-logs/${id}.json`;
		let content: string;
		try {
			content = await fs.readFile(logPath, 'utf8');
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
				throw httpError(HttpErrorCode.NOT_FOUND, 'Debug log not found');
			}
			console.error('Failed to read debug log file:', error);
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to read debug log');
		}

		try {
			JSON.parse(content);
		} catch {
			console.error(`Debug log file contains invalid JSON: ${logPath}`);
			throw httpError(HttpErrorCode.DATA_CORRUPTED, 'Debug log file is corrupted');
		}

		return c.body(content, 200, { 'Content-Type': 'application/json' });
	});

export type AIRoutes = typeof aiRoutes;
