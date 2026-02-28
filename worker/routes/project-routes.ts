/**
 * Project management routes.
 * Handles project creation, expiration, and download.
 */

import fs from 'node:fs/promises';

import { Hono } from 'hono';

import { HIDDEN_ENTRIES } from '@shared/constants';
import { generateHumanId } from '@shared/human-id';
import { projectMetaSchema } from '@shared/validation';

import { coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import { createZip } from '../lib/zip';

import type { AppEnvironment } from '../types';
import type { ProjectMeta } from '@shared/types';

/**
 * Project routes - all routes are prefixed with /api
 */
export const projectRoutes = new Hono<AppEnvironment>()
	// POST /api/new-project - Create a new project
	.post('/new-project', async (c) => {
		const id = filesystemNamespace.newUniqueId();
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
			throw httpError(400, parsed.error.message);
		}

		let meta: ProjectMeta;
		try {
			const raw = await fs.readFile(metaPath, 'utf8');
			meta = JSON.parse(raw);
		} catch {
			meta = { name: 'Untitled', humanId: generateHumanId() };
		}
		if (parsed.data.name) meta.name = parsed.data.name;
		const dependenciesChanged = parsed.data.dependencies !== undefined;
		if (dependenciesChanged) meta.dependencies = parsed.data.dependencies;
		await fs.writeFile(metaPath, JSON.stringify(meta));

		// Trigger full reload when dependencies change so the preview rebundles
		if (dependenciesChanged) {
			const projectId = c.get('projectId');
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
			await coordinatorStub.triggerUpdate({
				type: 'full-reload',
				path: '/.project-meta.json',
				timestamp: Date.now(),
				isCSS: false,
			});
		}

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

		let projectName = 'my-worker-app';
		let registeredDependencies: Record<string, string> = {};

		// Read project metadata for name and dependencies
		try {
			const metaRaw = await fs.readFile(`${projectRoot}/.project-meta.json`, 'utf8');
			const meta: ProjectMeta = JSON.parse(metaRaw);
			projectName = meta.name || meta.humanId || projectName;
			registeredDependencies = meta.dependencies ?? {};
		} catch {
			// Fall back to defaults
		}

		const hasReact = 'react' in registeredDependencies;
		const hasTypeScript = Object.keys(projectFiles).some((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
		const hasTests = Object.keys(projectFiles).some((f) => f.includes('.test.') || f.includes('.spec.') || f.startsWith('test/'));

		const devDependencies: Record<string, string> = {
			'@cloudflare/vite-plugin': '^1.0.0',
			vite: '^6.0.0',
			wrangler: '^4.0.0',
		};
		if (hasReact) {
			devDependencies['@types/react'] = '^19.0.0';
			devDependencies['@types/react-dom'] = '^19.0.0';
			devDependencies['@vitejs/plugin-react'] = '^4.0.0';
		}
		if (hasTypeScript) {
			devDependencies.typescript = '^5.0.0';
		}
		if (hasTests) {
			devDependencies.vitest = '^3.0.0';
		}

		const scripts: Record<string, string> = {
			dev: 'vite dev',
			build: 'vite build',
			deploy: 'vite build && wrangler deploy',
		};
		if (hasTests) {
			scripts.test = 'vitest run';
		}

		const packageJson: Record<string, unknown> = {
			name: projectName,
			type: 'module',
			scripts,
			dependencies: registeredDependencies,
			devDependencies,
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

		const viteImports = ["import { cloudflare } from '@cloudflare/vite-plugin';"];
		const vitePlugins = ['cloudflare()'];
		if (hasReact) {
			viteImports.unshift("import react from '@vitejs/plugin-react';");
			vitePlugins.unshift('react()');
		}

		zipFiles['vite.config.ts'] = [
			...viteImports,
			"import { defineConfig } from 'vite';",
			'',
			'export default defineConfig({',
			`\tplugins: [${vitePlugins.join(', ')}],`,
			'});',
			'',
		].join('\n');

		if (hasTests) {
			zipFiles['vitest.config.ts'] = [
				"import { defineConfig } from 'vitest/config';",
				'',
				'export default defineConfig({',
				'\ttest: {',
				'\t\tglobals: true,',
				"\t\tinclude: ['test/**/*.test.{js,ts,jsx,tsx}', 'src/**/*.test.{js,ts,jsx,tsx}'],",
				'\t},',
				'});',
				'',
			].join('\n');
		}

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
