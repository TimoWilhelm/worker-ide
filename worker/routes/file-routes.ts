/**
 * File operation routes.
 * Handles CRUD operations for project files.
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { HIDDEN_DIRECTORIES } from '@shared/constants';
import { filePathSchema, writeFileSchema, mkdirSchema } from '@shared/validation';

import { isPathSafe, isProtectedFile } from '../lib/path-utilities';

import type { AppEnvironment } from '../types';

/**
 * File routes - all routes are prefixed with /api
 * These routes are chained for Hono RPC type inference.
 */
export const fileRoutes = new Hono<AppEnvironment>()
	// GET /api/files - List all files in the project
	.get('/files', async (c) => {
		const projectRoot = c.get('projectRoot');
		const files = await listFilesRecursive(projectRoot);
		return c.json({ files });
	})

	// GET /api/file?path=/src/main.ts - Read file content
	.get('/file', zValidator('query', z.object({ path: filePathSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { path } = c.req.valid('query');

		if (!isPathSafe(projectRoot, path)) {
			return c.json({ error: 'Invalid path' }, 400);
		}

		try {
			const content = await fs.readFile(`${projectRoot}${path}`, 'utf8');
			return c.json({ path, content });
		} catch {
			return c.json({ error: 'File not found' }, 404);
		}
	})

	// PUT /api/file - Write file content
	.put('/file', zValidator('json', writeFileSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const environment = c.env;
		const { path, content } = c.req.valid('json');

		if (!isPathSafe(projectRoot, path)) {
			return c.json({ error: 'Invalid path' }, 400);
		}

		// Ensure directory exists
		const directory = path.slice(0, path.lastIndexOf('/'));
		if (directory) {
			await fs.mkdir(`${projectRoot}${directory}`, { recursive: true });
		}

		await fs.writeFile(`${projectRoot}${path}`, content);

		// Trigger HMR update
		const hmrId = environment.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
		const hmrStub = environment.DO_HMR_COORDINATOR.get(hmrId);
		const isCSS = path.endsWith('.css');
		await hmrStub.fetch(
			new Request('http://internal/hmr/trigger', {
				method: 'POST',
				body: JSON.stringify({
					type: isCSS ? 'update' : 'full-reload',
					path,
					timestamp: Date.now(),
					isCSS,
				}),
			}),
		);

		return c.json({ success: true, path });
	})

	// DELETE /api/file?path=/src/old.ts - Delete file
	.delete('/file', zValidator('query', z.object({ path: filePathSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { path } = c.req.valid('query');

		if (!isPathSafe(projectRoot, path)) {
			return c.json({ error: 'Invalid path' }, 400);
		}

		if (isProtectedFile(path)) {
			return c.json({ error: 'Cannot delete protected file' }, 403);
		}

		try {
			await fs.unlink(`${projectRoot}${path}`);
			return c.json({ success: true });
		} catch {
			return c.json({ error: 'Failed to delete file' }, 500);
		}
	})

	// POST /api/mkdir - Create directory
	.post('/mkdir', zValidator('json', mkdirSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { path } = c.req.valid('json');

		if (!isPathSafe(projectRoot, path)) {
			return c.json({ error: 'Invalid path' }, 400);
		}

		await fs.mkdir(`${projectRoot}${path}`, { recursive: true });
		return c.json({ success: true });
	});

/**
 * Recursively list all files in a directory.
 */
async function listFilesRecursive(directory: string, base = ''): Promise<string[]> {
	const files: string[] = [];
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			// Skip hidden directories
			if (HIDDEN_DIRECTORIES.has(entry.name)) continue;

			const relativePath = base ? `${base}/${entry.name}` : `/${entry.name}`;
			if (entry.isDirectory()) {
				files.push(...(await listFilesRecursive(`${directory}/${entry.name}`, relativePath)));
			} else {
				files.push(relativePath);
			}
		}
	} catch (error) {
		if (base === '') {
			console.error('listFilesRecursive error:', error);
		}
	}
	return files;
}

export type FileRoutes = typeof fileRoutes;
