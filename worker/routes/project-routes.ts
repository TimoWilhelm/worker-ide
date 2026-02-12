/**
 * Project management routes.
 * Handles project creation, expiration, and download.
 */

import fs from 'node:fs/promises';

import { Hono } from 'hono';

import { createZip } from '../lib/zip';

import type { AppEnvironment } from '../types';

/**
 * Type guard to check if a value is a string record (e.g. scripts or devDependencies from package.json).
 */
function isStringRecord(value: unknown): value is Record<string, string> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Project routes - all routes are prefixed with /api
 */
export const projectRoutes = new Hono<AppEnvironment>()
	// POST /api/new-project - Create a new project
	.post('/new-project', async (c) => {
		const environment = c.env;
		const id = environment.DO_FILESYSTEM.newUniqueId();
		const projectId = id.toString();
		return c.json({ projectId, url: `/p/${projectId}` });
	})

	// GET /api/expiration - Get project expiration info
	.get('/expiration', async (c) => {
		const fsStub = c.get('fsStub');
		const expirationTime = await fsStub.getExpirationTime();
		return c.json({
			expiresAt: expirationTime,
			expiresIn: expirationTime ? expirationTime - Date.now() : undefined,
		});
	})

	// GET /api/download - Download project as deployable zip
	.get('/download', async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectFiles = await collectFilesForBundle(projectRoot);
		delete projectFiles['.initialized'];

		let packageJson: Record<string, unknown> = {};
		let projectName = 'my-worker-app';
		if (projectFiles['package.json']) {
			try {
				packageJson = JSON.parse(projectFiles['package.json']);
				if (typeof packageJson.name === 'string') projectName = packageJson.name;
			} catch {
				// Ignore parse errors
			}
		}

		const existingScripts = isStringRecord(packageJson.scripts) ? packageJson.scripts : {};
		packageJson.scripts = {
			...existingScripts,
			dev: 'vite dev',
			build: 'vite build',
			deploy: 'vite build && wrangler deploy',
		};
		const existingDevelopmentDependencies = isStringRecord(packageJson.devDependencies) ? packageJson.devDependencies : {};
		packageJson.devDependencies = {
			...existingDevelopmentDependencies,
			'@cloudflare/vite-plugin': '^1.0.0',
			vite: '^6.0.0',
			wrangler: '^4.0.0',
		};

		const prefix = `${projectName}/`;
		const zipFiles: Record<string, string> = {};

		for (const [filePath, content] of Object.entries(projectFiles)) {
			if (filePath === 'package.json') continue;
			zipFiles[`${prefix}${filePath}`] = content;
		}

		zipFiles[`${prefix}package.json`] = JSON.stringify(packageJson, undefined, 2);

		zipFiles[`${prefix}wrangler.jsonc`] = JSON.stringify(
			{
				$schema: 'node_modules/wrangler/config-schema.json',
				name: projectName,
				main: 'worker/index.ts',
				compatibility_date: '2026-01-31',
				assets: {
					not_found_handling: 'single-page-application',
				},
				observability: {
					enabled: true,
				},
			},
			undefined,
			'\t',
		);

		zipFiles[`${prefix}vite.config.ts`] = [
			"import { defineConfig } from 'vite';",
			"import { cloudflare } from '@cloudflare/vite-plugin';",
			'',
			'export default defineConfig({',
			'\tplugins: [cloudflare()],',
			'});',
			'',
		].join('\n');

		const zip = createZip(zipFiles);
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
				.filter((entry: { name: string }) => entry.name !== '.ai-sessions' && entry.name !== '.snapshots')
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
