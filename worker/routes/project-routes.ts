/**
 * Project management routes.
 * Handles project creation, expiration, and download.
 */

import fs from 'node:fs/promises';

import { Hono } from 'hono';

import { generateHumanId } from '@shared/human-id';
import { projectMetaSchema } from '@shared/validation';

import { createZip } from '../lib/zip';

import type { AppEnvironment } from '../types';
import type { ProjectMeta } from '@shared/types';

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
		const projectName = generateHumanId();
		return c.json({ projectId, url: `/p/${projectId}`, name: projectName });
	})

	// GET /api/project/meta - Get project metadata
	.get('/project/meta', async (c) => {
		const projectRoot = c.get('projectRoot');
		const metaPath = `${projectRoot}/.project-meta.json`;
		try {
			const raw = await fs.readFile(metaPath, 'utf8');
			const meta: ProjectMeta = JSON.parse(raw);
			return c.json(meta);
		} catch {
			// No meta file yet — generate one
			const projectName = generateHumanId();
			const meta: ProjectMeta = { name: projectName, humanId: projectName };
			await fs.writeFile(metaPath, JSON.stringify(meta));
			return c.json(meta);
		}
	})

	// PUT /api/project/meta - Update project metadata (rename)
	.put('/project/meta', async (c) => {
		const projectRoot = c.get('projectRoot');
		const metaPath = `${projectRoot}/.project-meta.json`;
		const body = await c.req.json();
		const parsed = projectMetaSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: parsed.error.message }, 400);
		}

		let meta: ProjectMeta;
		try {
			const raw = await fs.readFile(metaPath, 'utf8');
			meta = JSON.parse(raw);
			meta.name = parsed.data.name;
		} catch {
			meta = { name: parsed.data.name, humanId: generateHumanId() };
		}
		await fs.writeFile(metaPath, JSON.stringify(meta));
		return c.json(meta);
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
		delete projectFiles['.project-meta.json'];

		let packageJson: Record<string, unknown> = {};
		let projectName = 'my-worker-app';

		// Use the project name from metadata (may have been renamed by the user)
		try {
			const metaRaw = await fs.readFile(`${projectRoot}/.project-meta.json`, 'utf8');
			const meta: ProjectMeta = JSON.parse(metaRaw);
			projectName = meta.name || meta.humanId || projectName;
		} catch {
			// Fall back to default
		}

		if (projectFiles['package.json']) {
			try {
				packageJson = JSON.parse(projectFiles['package.json']);
			} catch {
				// Ignore parse errors
			}
		}
		packageJson.name = projectName;

		const existingScripts = isStringRecord(packageJson.scripts) ? packageJson.scripts : {};
		packageJson.scripts = {
			...existingScripts,
			dev: 'vite dev',
			build: 'vite build',
			deploy: 'vite build && wrangler deploy',
		};
		// Detect bare imports from project source files to populate dependencies
		const detectedDependencies = detectBareImports(projectFiles);
		const existingDependencies = isStringRecord(packageJson.dependencies) ? packageJson.dependencies : {};
		packageJson.dependencies = {
			...Object.fromEntries([...detectedDependencies].toSorted().map((dep) => [dep, 'latest'])),
			...existingDependencies,
		};
		const existingDevelopmentDependencies = isStringRecord(packageJson.devDependencies) ? packageJson.devDependencies : {};
		packageJson.devDependencies = {
			...existingDevelopmentDependencies,
			'@cloudflare/vite-plugin': '^1.0.0',
			vite: '^6.0.0',
			wrangler: '^4.0.0',
		};

		const zipFiles: Record<string, string> = {};

		for (const [filePath, content] of Object.entries(projectFiles)) {
			if (filePath === 'package.json') continue;
			zipFiles[filePath] = content;
		}

		zipFiles['package.json'] = JSON.stringify(packageJson, undefined, 2);

		zipFiles['wrangler.jsonc'] = JSON.stringify(
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

		zipFiles['vite.config.ts'] = [
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
				.filter((entry: { name: string }) => entry.name !== '.agent')
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

/**
 * Scan project source files for bare import specifiers (npm packages).
 * Returns a Set of top-level package names (e.g. 'react', 'hono', '@scope/pkg').
 */
function detectBareImports(files: Record<string, string>): Set<string> {
	const packages = new Set<string>();
	const importPattern = /(?:import|export)\s.*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

	for (const [filePath, content] of Object.entries(files)) {
		if (!/\.(ts|tsx|js|jsx|mts|mjs)$/.test(filePath)) continue;

		let match;
		while ((match = importPattern.exec(content))) {
			const specifier = match[1] || match[2];
			// Skip relative, absolute, and protocol imports
			if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes('://')) continue;
			// Extract top-level package name (handle scoped packages like @scope/pkg)
			const parts = specifier.split('/');
			const packageName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
			packages.add(packageName);
		}
	}

	return packages;
}

export type ProjectRoutes = typeof projectRoutes;
