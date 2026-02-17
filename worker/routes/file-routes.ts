/**
 * File operation routes.
 * Handles CRUD operations for project files.
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import { z } from 'zod';

import { HIDDEN_ENTRIES } from '@shared/constants';
import { filePathSchema, writeFileSchema, mkdirSchema, moveFileSchema } from '@shared/validation';

import { isPathSafe, isProtectedFile } from '../lib/path-utilities';
import { invalidateTsConfigCache } from '../services/transform-service';

import type { AppEnvironment } from '../types';
import type { FileInfo } from '@shared/types';

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
		const coordinatorId = exports.ProjectCoordinator.idFromName(`project:${projectId}`);
		const coordinatorStub = exports.ProjectCoordinator.get(coordinatorId);
		const isCSS = path.endsWith('.css');
		await coordinatorStub.triggerUpdate({
			type: isCSS ? 'update' : 'full-reload',
			path,
			timestamp: Date.now(),
			isCSS,
		});

		// Notify clients that git status may have changed
		await coordinatorStub.sendMessage({ type: 'git-status-changed' });

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

		if (path === '/.git' || path.startsWith('/.git/')) {
			return c.json({ error: 'Cannot modify git repository internals' }, 403);
		}

		try {
			await fs.rm(`${projectRoot}${path}`, { recursive: true, force: true });

			// Trigger HMR so the frontend refreshes the file list
			const projectId = c.get('projectId');
			const coordinatorId = exports.ProjectCoordinator.idFromName(`project:${projectId}`);
			const coordinatorStub = exports.ProjectCoordinator.get(coordinatorId);
			await coordinatorStub.triggerUpdate({
				type: 'full-reload',
				path,
				timestamp: Date.now(),
				isCSS: false,
			});

			// Notify clients that git status may have changed
			await coordinatorStub.sendMessage({ type: 'git-status-changed' });

			return c.json({ success: true });
		} catch {
			return c.json({ error: 'Failed to delete file' }, 500);
		}
	})

	// PATCH /api/file - Move/rename file
	.patch('/file', zValidator('json', moveFileSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
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
			const coordinatorId = exports.ProjectCoordinator.idFromName(`project:${projectId}`);
			const coordinatorStub = exports.ProjectCoordinator.get(coordinatorId);
			await coordinatorStub.triggerUpdate({
				type: 'full-reload',
				path: toPath,
				timestamp: Date.now(),
				isCSS: false,
			});

			// Notify clients that git status may have changed
			await coordinatorStub.sendMessage({ type: 'git-status-changed' });

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
 * Recursively list all files and directories in a directory.
 */
async function listFilesRecursive(directory: string, base = ''): Promise<FileInfo[]> {
	const files: FileInfo[] = [];
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			// Skip hidden entries (internal directories and files)
			if (HIDDEN_ENTRIES.has(entry.name)) continue;

			const relativePath = base ? `${base}/${entry.name}` : `/${entry.name}`;

			// Add the current entry
			files.push({
				path: relativePath,
				name: entry.name,
				isDirectory: entry.isDirectory(),
			});

			if (entry.isDirectory()) {
				files.push(...(await listFilesRecursive(`${directory}/${entry.name}`, relativePath)));
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
