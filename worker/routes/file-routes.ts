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

import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
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
			throw httpError(400, 'Invalid path');
		}

		try {
			const content = await fs.readFile(`${projectRoot}${path}`, 'utf8');
			return c.json({ path, content });
		} catch {
			throw httpError(404, 'File not found');
		}
	})

	// PUT /api/file - Write file content
	.put('/file', zValidator('json', writeFileSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { path, content } = c.req.valid('json');

		if (!isPathSafe(projectRoot, path)) {
			throw httpError(400, 'Invalid path');
		}

		if (path === '/package.json') {
			throw httpError(400, 'Dependencies are managed at the project level. Use the Dependencies panel in the sidebar.');
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
		const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
		const coordinatorStub = coordinatorNamespace.get(coordinatorId);
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
			throw httpError(400, 'Invalid path');
		}

		if (isProtectedFile(path)) {
			throw httpError(403, 'Cannot delete protected file');
		}

		if (path === '/.git' || path.startsWith('/.git/')) {
			throw httpError(403, 'Cannot modify git repository internals');
		}

		try {
			await fs.rm(`${projectRoot}${path}`, { recursive: true, force: true });

			// Trigger HMR so the frontend refreshes the file list
			const projectId = c.get('projectId');
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
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
			throw httpError(500, 'Failed to delete file');
		}
	})

	// PATCH /api/file - Move/rename file
	.patch('/file', zValidator('json', moveFileSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { from_path: fromPath, to_path: toPath } = c.req.valid('json');

		if (!isPathSafe(projectRoot, fromPath) || !isPathSafe(projectRoot, toPath)) {
			throw httpError(400, 'Invalid path');
		}

		if (isProtectedFile(fromPath)) {
			throw httpError(403, 'Cannot move protected file');
		}

		try {
			// Ensure destination directory exists
			const toDirectory = toPath.slice(0, toPath.lastIndexOf('/'));
			if (toDirectory) {
				await fs.mkdir(`${projectRoot}${toDirectory}`, { recursive: true });
			}

			await fs.rename(`${projectRoot}${fromPath}`, `${projectRoot}${toPath}`);

			// Trigger HMR so the frontend refreshes
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
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
			throw httpError(500, 'Failed to move file');
		}
	})

	// POST /api/mkdir - Create directory
	.post('/mkdir', zValidator('json', mkdirSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { path } = c.req.valid('json');

		if (!isPathSafe(projectRoot, path)) {
			throw httpError(400, 'Invalid path');
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
