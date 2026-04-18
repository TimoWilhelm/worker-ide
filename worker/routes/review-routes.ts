import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { HttpErrorCode } from '@shared/http-errors';
import { reviewHunkUpdateSchema, reviewResolveManySchema, reviewResolveSchema } from '@shared/validation';

import { agentRunnerNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';

import type { AppEnvironment } from '../types';

const reviewIdParameterSchema = z.object({ id: z.string().min(1) });

export const reviewRoutes = new Hono<AppEnvironment>()
	.get('/review', async (c) => {
		const projectId = c.get('projectId');
		const agentStub = agentRunnerNamespace.getByName(`agent:${projectId}`);
		try {
			const response = await agentStub.fetch(
				new Request('http://agent/review', {
					headers: { 'x-partykit-room': `agent:${projectId}` },
				}),
			);
			if (!response.ok) {
				throw new Error(await response.text());
			}
			const body: unknown = await response.json();
			const entries = body && typeof body === 'object' && 'entries' in body && Array.isArray(body.entries) ? body.entries : [];
			return c.json({ entries });
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to load review queue';
			throw httpError(HttpErrorCode.INTERNAL_ERROR, message);
		}
	})
	.put('/review/:id/hunks', zValidator('param', reviewIdParameterSchema), zValidator('json', reviewHunkUpdateSchema), async (c) => {
		const projectId = c.get('projectId');
		const { id } = c.req.valid('param');
		const { hunkStatuses } = c.req.valid('json');
		const agentStub = agentRunnerNamespace.getByName(`agent:${projectId}`);
		try {
			const response = await agentStub.fetch(
				new Request(`http://agent/review/${id}/hunks`, {
					method: 'PUT',
					headers: {
						'Content-Type': 'application/json',
						'x-partykit-room': `agent:${projectId}`,
					},
					body: JSON.stringify({ hunkStatuses }),
				}),
			);
			if (!response.ok) {
				throw new Error(await response.text());
			}
			return c.json({ success: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to update review hunks';
			throw httpError(HttpErrorCode.INTERNAL_ERROR, message);
		}
	})
	.post('/review/:id/resolve', zValidator('param', reviewIdParameterSchema), zValidator('json', reviewResolveSchema), async (c) => {
		const projectId = c.get('projectId');
		const { id } = c.req.valid('param');
		const { decision } = c.req.valid('json');
		const agentStub = agentRunnerNamespace.getByName(`agent:${projectId}`);
		try {
			const response = await agentStub.fetch(
				new Request(`http://agent/review/${id}/resolve`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-partykit-room': `agent:${projectId}`,
					},
					body: JSON.stringify({ decision }),
				}),
			);
			if (!response.ok) {
				throw new Error(await response.text());
			}
			return c.json({ success: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to resolve review entry';
			throw httpError(HttpErrorCode.INTERNAL_ERROR, message);
		}
	})
	.post('/review/resolve-many', zValidator('json', reviewResolveManySchema), async (c) => {
		const projectId = c.get('projectId');
		const { decision, sessionId, reviewIds } = c.req.valid('json');
		const agentStub = agentRunnerNamespace.getByName(`agent:${projectId}`);
		try {
			const response = await agentStub.fetch(
				new Request('http://agent/review/resolve-many', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-partykit-room': `agent:${projectId}`,
					},
					body: JSON.stringify({ decision, sessionId, reviewIds }),
				}),
			);
			if (!response.ok) {
				throw new Error(await response.text());
			}
			return c.json({ success: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to resolve review entries';
			throw httpError(HttpErrorCode.INTERNAL_ERROR, message);
		}
	});

export type ReviewRoutes = typeof reviewRoutes;
