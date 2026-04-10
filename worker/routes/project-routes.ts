/**
 * Project management routes.
 * Handles project creation, expiration, and download.
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { BINARY_EXTENSIONS, HIDDEN_ENTRIES } from '@shared/constants';
import { HttpErrorCode } from '@shared/http-errors';
import { dependenciesUpdateSchema, projectMetaSchema, visibilityBodySchema } from '@shared/validation';

import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import {
	readAssetSettings,
	readBindingsConfig,
	readDependencies,
	readProjectName,
	regenerateProtectedFiles,
	writeAssetSettings,
	writeBindingsConfig,
	writeDependencies,
	writeProjectName,
} from '../lib/protected-files';
import { resolveStorageQuotaForProject } from '../lib/storage-quota';
import { createZip } from '../lib/zip';

import type { AppEnvironment } from '../types';

/**
 * Project routes - all routes are prefixed with /api
 */
export const projectRoutes = new Hono<AppEnvironment>()
	// GET /api/project/meta - Get project metadata (name + asset settings + bindings config from actual files)
	.get('/project/meta', async (c) => {
		const projectRoot = c.get('projectRoot');
		const name = await readProjectName(projectRoot);
		const assetSettings = await readAssetSettings(projectRoot);
		const bindingsConfig = await readBindingsConfig(projectRoot);
		return c.json({ name, humanId: name, assetSettings, bindingsConfig });
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

		// Update bindings config in wrangler.jsonc if provided
		if (parsed.data.bindingsConfig !== undefined) {
			await writeBindingsConfig(projectRoot, parsed.data.bindingsConfig);
		}

		// Regenerate all protected files to keep them in sync
		if (parsed.data.name || parsed.data.assetSettings !== undefined || parsed.data.bindingsConfig !== undefined) {
			await regenerateProtectedFiles(projectRoot);
		}

		// Trigger full reload when asset settings or bindings change so the preview rebundles
		if (parsed.data.assetSettings !== undefined || parsed.data.bindingsConfig !== undefined) {
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
		const bindingsConfig = await readBindingsConfig(projectRoot);
		return c.json({ name, humanId: name, assetSettings, bindingsConfig });
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

	// GET /api/project/storage - Get storage usage and quota
	.get('/project/storage', async (c) => {
		const projectId = c.get('projectId');
		const bindingsConfig = await readBindingsConfig(c.get('projectRoot'));

		if (!bindingsConfig.storage) {
			return c.json({ usageBytes: 0, quotaBytes: 0, enabled: false });
		}

		const quotaBytes = await resolveStorageQuotaForProject(projectId, c.env.DB);
		const { projectMetadataNamespace } = await import('../lib/durable-object-namespaces');
		const metadataStub = projectMetadataNamespace.getByName(`project:${projectId}`);
		const usageBytes = await metadataStub.getStorageUsageBytes();

		return c.json({ usageBytes, quotaBytes, enabled: true });
	})

	// GET /api/download - Download project as deployable zip
	.get('/download', async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectFiles = await collectFilesForBundle(projectRoot);
		delete projectFiles['.initialized'];

		const projectName = await readProjectName(projectRoot);

		// Transform wrangler.jsonc for export: strip IDE-specific `bindings` field,
		// add real `r2_buckets` config if storage binding is enabled
		if (projectFiles['wrangler.jsonc']) {
			try {
				const { default: stripJsonComments } = await import('strip-json-comments');
				const wranglerRaw = projectFiles['wrangler.jsonc'];
				const wranglerConfig = JSON.parse(stripJsonComments(typeof wranglerRaw === 'string' ? wranglerRaw : new TextDecoder().decode(wranglerRaw)));
				const bindingsConfig = wranglerConfig.bindings;
				delete wranglerConfig.bindings;

				if (bindingsConfig?.storage) {
					wranglerConfig.r2_buckets = [{ binding: 'STORAGE', bucket_name: 'my-bucket' }];
				}

				projectFiles['wrangler.jsonc'] = JSON.stringify(wranglerConfig, undefined, '\t');
			} catch {
				// If parsing fails, export the file as-is
			}
		}

		const zip = createZip(projectFiles);
		const safeName = projectName.replaceAll(/["\\\n\r]/g, '_');
		return new Response(zip, {
			headers: {
				'Content-Type': 'application/zip',
				'Content-Disposition': `attachment; filename="${safeName}.zip"`,
				'Access-Control-Allow-Origin': '*',
			},
		});
	});

/**
 * Collect all files in a directory for bundling.
 */
async function collectFilesForBundle(directory: string, base = ''): Promise<Record<string, string | Uint8Array>> {
	const files: Record<string, string | Uint8Array> = {};
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
						const extension = entry.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '';
						if (BINARY_EXTENSIONS.has(extension)) {
							const buffer = await fs.readFile(fullPath);
							return { [relativePath]: new Uint8Array(buffer) };
						}
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
