/**
 * File operation routes.
 * Handles CRUD operations for project files.
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { HIDDEN_ENTRIES } from '@shared/constants';
import { filePathSchema, writeFileSchema, mkdirSchema, moveFileSchema } from '@shared/validation';

import { isPathSafe, isProtectedFile } from '../lib/path-utilities';
import { invalidateTsConfigCache } from '../services/transform-service';

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

		if (path === '/package.json') {
			return c.json({ error: 'Dependencies are managed at the project level. Use the Dependencies panel in the sidebar.' }, 400);
		}

		// Ensure directory exists
		const directory = path.slice(0, path.lastIndexOf('/'));
		if (directory) {
			await fs.mkdir(`${projectRoot}${directory}`, { recursive: true });
		}

		await fs.writeFile(`${projectRoot}${path}`, content);

		// Invalidate tsconfig cache when tsconfig.json is modified
		if (path === '/tsconfig.json') {
			invalidateTsConfigCache(projectRoot);
		}

		// Trigger HMR update
		const coordinatorId = environment.DO_PROJECT_COORDINATOR.idFromName(`project:${projectId}`);
		const coordinatorStub = environment.DO_PROJECT_COORDINATOR.get(coordinatorId);
		const isCSS = path.endsWith('.css');
		await coordinatorStub.triggerUpdate({
			type: isCSS ? 'update' : 'full-reload',
			path,
			timestamp: Date.now(),
			isCSS,
		});

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

			// Trigger HMR so the frontend refreshes the file list
			const projectId = c.get('projectId');
			const environment = c.env;
			const coordinatorId = environment.DO_PROJECT_COORDINATOR.idFromName(`project:${projectId}`);
			const coordinatorStub = environment.DO_PROJECT_COORDINATOR.get(coordinatorId);
			await coordinatorStub.triggerUpdate({
				type: 'full-reload',
				path,
				timestamp: Date.now(),
				isCSS: false,
			});

			return c.json({ success: true });
		} catch {
			return c.json({ error: 'Failed to delete file' }, 500);
		}
	})

	// PATCH /api/file - Move/rename file
	.patch('/file', zValidator('json', moveFileSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const environment = c.env;
		const { from_path: fromPath, to_path: toPath } = c.req.valid('json');

		if (!isPathSafe(projectRoot, fromPath) || !isPathSafe(projectRoot, toPath)) {
			return c.json({ error: 'Invalid path' }, 400);
		}

		if (isProtectedFile(fromPath)) {
			return c.json({ error: 'Cannot move protected file' }, 403);
		}

		try {
			// Ensure destination directory exists
			const toDirectory = toPath.slice(0, toPath.lastIndexOf('/'));
			if (toDirectory) {
				await fs.mkdir(`${projectRoot}${toDirectory}`, { recursive: true });
			}

			await fs.rename(`${projectRoot}${fromPath}`, `${projectRoot}${toPath}`);

			// Trigger HMR so the frontend refreshes
			const coordinatorId = environment.DO_PROJECT_COORDINATOR.idFromName(`project:${projectId}`);
			const coordinatorStub = environment.DO_PROJECT_COORDINATOR.get(coordinatorId);
			await coordinatorStub.triggerUpdate({
				type: 'full-reload',
				path: toPath,
				timestamp: Date.now(),
				isCSS: false,
			});

			return c.json({ success: true, from: fromPath, to: toPath });
		} catch {
			return c.json({ error: 'Failed to move file' }, 500);
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
			// Skip hidden entries (internal directories and files)
			if (HIDDEN_ENTRIES.has(entry.name)) continue;

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
