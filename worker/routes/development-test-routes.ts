import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { addFileToSnapshot, initSnapshot } from '../services/agent/snapshot-manager';

import type { FileChange, ModelMessage } from '../services/agent/types';
import type { AppEnvironment } from '../types';

const seedSnapshotSchema = z.object({
	label: z.string().optional(),
	sessionId: z.string().optional(),
	changes: z
		.array(
			z.object({
				path: z.string(),
				action: z.enum(['create', 'edit', 'delete']),
				beforeContent: z.string().optional(),
			}),
		)
		.min(1),
});

/**
 * Dev/test-only routes. These are mounted only when `import.meta.env.DEV` is
 * truthy (see worker/index.ts) and must never be available in production.
 *
 * The integration suite uses these to seed internal fixtures (e.g. agent
 * snapshots) through the *real* internal mechanisms — the same
 * snapshot-manager functions the agent uses — instead of writing hidden files
 * via the public file API (which now rejects hidden paths).
 */
export const developmentTestRoutes = new Hono<AppEnvironment>().post(
	'/__test/seed-snapshot',
	zValidator('json', seedSnapshotSchema),
	async (c) => {
		const projectRoot = c.get('projectRoot');
		const { label, sessionId, changes } = c.req.valid('json');

		// initSnapshot derives the label from the last user message; synthesize
		// one so callers can control the label deterministically.
		const messages: ModelMessage[] = label === undefined ? [] : [{ role: 'user', content: label }];

		const context = await initSnapshot(projectRoot, sessionId, messages, () => {});

		for (const change of changes) {
			const fileChange: FileChange = {
				path: change.path,
				action: change.action,
				beforeContent: change.beforeContent,
				afterContent: undefined,
				isBinary: false,
			};
			await addFileToSnapshot(context, fileChange);
		}

		return c.json({ id: context.id });
	},
);
