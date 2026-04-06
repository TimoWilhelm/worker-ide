/**
 * Project management routes.
 * Handles project creation, expiration, and download.
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { HIDDEN_ENTRIES } from '@shared/constants';
import { HttpErrorCode } from '@shared/http-errors';
import { dependenciesUpdateSchema, projectMetaSchema, visibilityBodySchema } from '@shared/validation';

import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import {
	readAssetSettings,
	readDependencies,
	readProjectName,
	regenerateProtectedFiles,
	writeAssetSettings,
	writeDependencies,
	writeProjectName,
} from '../lib/protected-files';
import { createZip } from '../lib/zip';

import type { AppEnvironment } from '../types';

/**
 * Project routes - all routes are prefixed with /api
 */
export const projectRoutes = new Hono<AppEnvironment>()
	// GET /api/project/meta - Get project metadata (name + asset settings from actual files)
	.get('/project/meta', async (c) => {
		const projectRoot = c.get('projectRoot');
		const name = await readProjectName(projectRoot);
		const assetSettings = await readAssetSettings(projectRoot);
		return c.json({ name, humanId: name, assetSettings });
	})

	// PUT /api/project/meta - Update project name and/or asset settings
	.put('/project/meta', async (c) => {
		const projectRoot = c.get('projectRoot');
		const body = await c.req.json();
		const parsed = projectMetaSchema.safeParse(body);
		if (!parsed.success) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, parsed.error.message);
		}

		// Update name in package.json if provided (creates the file if missing)
		if (parsed.data.name) {
			await writeProjectName(projectRoot, parsed.data.name);
		}

		// Update asset settings in wrangler.jsonc if provided
		if (parsed.data.assetSettings !== undefined) {
			await writeAssetSettings(projectRoot, parsed.data.assetSettings);
		}

		// Regenerate all protected files to keep them in sync
		if (parsed.data.name || parsed.data.assetSettings !== undefined) {
			await regenerateProtectedFiles(projectRoot);
		}

		// Trigger full reload when asset settings change so the preview rebundles
		if (parsed.data.assetSettings !== undefined) {
			const projectId = c.get('projectId');
			const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
			await coordinatorStub.triggerUpdate({
				type: 'full-reload',
				path: '/wrangler.jsonc',
				timestamp: Date.now(),
				isCSS: false,
			});
		}

		const name = await readProjectName(projectRoot);
		const assetSettings = await readAssetSettings(projectRoot);
		return c.json({ name, humanId: name, assetSettings });
	})

	// GET /api/dependencies - Read dependencies from package.json
	.get('/dependencies', async (c) => {
		const projectRoot = c.get('projectRoot');
		const dependencies = await readDependencies(projectRoot);
		return c.json({ dependencies });
	})

	// PUT /api/dependencies - Update dependencies in package.json
	.put('/dependencies', zValidator('json', dependenciesUpdateSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { dependencies } = c.req.valid('json');
		await writeDependencies(projectRoot, dependencies);

		// Regenerate all protected files so vite.config.ts, devDependencies, etc. stay in sync
		await regenerateProtectedFiles(projectRoot);

		// Trigger full reload so the preview rebundles with new dependencies
		const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
		await coordinatorStub.triggerUpdate({
			type: 'full-reload',
			path: '/package.json',
			timestamp: Date.now(),
			isCSS: false,
		});

		return c.json({ dependencies });
	})

	// GET /api/project/visibility - Get preview visibility
	.get('/project/visibility', async (c) => {
		const projectId = c.get('projectId');
		const { drizzle } = await import('drizzle-orm/d1');
		const { eq } = await import('drizzle-orm');
		const schema = await import('../db/auth-schema');
		const database = drizzle(c.env.DB);
		const rows = await database
			.select({ previewVisibility: schema.project.previewVisibility })
			.from(schema.project)
			.where(eq(schema.project.id, projectId))
			.limit(1);
		const visibility = rows[0]?.previewVisibility ?? 'public';
		return c.json({ visibility });
	})

	// PUT /api/project/visibility - Update preview visibility
	.put('/project/visibility', zValidator('json', visibilityBodySchema), async (c) => {
		const projectId = c.get('projectId');
		const body = c.req.valid('json');
		const { drizzle } = await import('drizzle-orm/d1');
		const { eq } = await import('drizzle-orm');
		const schema = await import('../db/auth-schema');
		const database = drizzle(c.env.DB);
		await database
			.update(schema.project)
			.set({ previewVisibility: body.visibility, updatedAt: new Date() })
			.where(eq(schema.project.id, projectId));
		return c.json({ visibility: body.visibility });
	})

	// GET /api/download - Download project as deployable zip
	.get('/download', async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectFiles = await collectFilesForBundle(projectRoot);
		delete projectFiles['.initialized'];

		const projectName = await readProjectName(projectRoot);

		const zip = createZip(projectFiles);
		return new Response(zip, {
			headers: {
				'Content-Type': 'application/zip',
				'Content-Disposition': `attachment; filename="${projectName}.zip"`,
				'Access-Control-Allow-Origin': '*',
			},
		});
	});

/**
 * Collect all files in a directory for bundling.
 */
async function collectFilesForBundle(directory: string, base = ''): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const results = await Promise.all(
			entries
				.filter((entry: { name: string }) => !HIDDEN_ENTRIES.has(entry.name))
				.map(async (entry: { name: string; isDirectory: () => boolean }) => {
					const relativePath = base ? `${base}/${entry.name}` : entry.name;
					const fullPath = `${directory}/${entry.name}`;
					if (entry.isDirectory()) {
						return collectFilesForBundle(fullPath, relativePath);
					} else {
						const content = await fs.readFile(fullPath, 'utf8');
						return { [relativePath]: content };
					}
				}),
		);
		for (const result of results) {
			Object.assign(files, result);
		}
	} catch (error) {
		if (base === '') {
			console.error('collectFilesForBundle error:', error);
		}
	}
	return files;
}

export type ProjectRoutes = typeof projectRoutes;
