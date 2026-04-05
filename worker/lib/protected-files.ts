/**
 * Protected file generation utilities.
 *
 * System files (package.json, wrangler.jsonc, vite.config.ts, vitest.config.ts)
 * live in the project filesystem so git can track them. They are regenerated
 * whenever project settings change (name, dependencies, asset settings).
 *
 * All project configuration is stored in these files directly:
 * - `package.json` — name, dependencies, devDependencies, scripts
 * - `wrangler.jsonc` — name, main, compatibility_date, asset routing settings
 * - `vite.config.ts` — Vite plugins (React, Cloudflare)
 * - `vitest.config.ts` — test runner configuration
 */

import fs from 'node:fs/promises';

import stripJsonComments from 'strip-json-comments';

import { PROTECTED_SYSTEM_FILES, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { resolveAssetSettings } from '@shared/types';

import type { AssetSettings } from '@shared/types';

// =============================================================================
// Helpers
// =============================================================================

interface ProjectFileFlags {
	hasReact: boolean;
	hasTypeScript: boolean;
	hasTests: boolean;
}

/**
 * Detect project characteristics from registered dependencies and file paths.
 */
function detectProjectFlags(dependencies: Record<string, string>, filePaths: string[]): ProjectFileFlags {
	return {
		hasReact: 'react' in dependencies,
		hasTypeScript: filePaths.some((f) => f.endsWith('.ts') || f.endsWith('.tsx')),
		hasTests: filePaths.some((f) => f.includes('.test.') || f.includes('.spec.') || f.startsWith('test/')),
	};
}

// =============================================================================
// package.json I/O
// =============================================================================

/**
 * Read the `dependencies` field from `package.json` on disk.
 */
export async function readDependencies(projectRoot: string): Promise<Record<string, string>> {
	try {
		const raw = await fs.readFile(`${projectRoot}/package.json`, 'utf8');
		const parsed: { dependencies?: Record<string, string> } = JSON.parse(raw);
		return parsed.dependencies ?? {};
	} catch {
		return {};
	}
}

/**
 * Write updated `dependencies` into `package.json` on disk.
 * Does NOT regenerate other protected files — call `regenerateProtectedFiles` afterward.
 */
export async function writeDependencies(projectRoot: string, dependencies: Record<string, string>): Promise<void> {
	// Intentionally a no-op on package.json structure; regenerateProtectedFiles
	// will rewrite the full file. We just need to persist the dependencies value
	// so the subsequent regenerateProtectedFiles call reads them back.
	const packageJsonPath = `${projectRoot}/package.json`;
	let existing: Record<string, unknown> = {};
	try {
		const raw = await fs.readFile(packageJsonPath, 'utf8');
		existing = JSON.parse(raw);
	} catch {
		// No existing package.json — will create one
	}
	existing.dependencies = dependencies;
	await fs.writeFile(packageJsonPath, JSON.stringify(existing, undefined, 2));
}

/**
 * Read the project name from `package.json`.
 */
export async function readProjectName(projectRoot: string): Promise<string> {
	try {
		const raw = await fs.readFile(`${projectRoot}/package.json`, 'utf8');
		const parsed: { name?: string } = JSON.parse(raw);
		return parsed.name || 'my-worker-app';
	} catch {
		return 'my-worker-app';
	}
}

/**
 * Write the project name into `package.json` on disk.
 * Creates the file if it doesn't exist.
 */
export async function writeProjectName(projectRoot: string, name: string): Promise<void> {
	const packageJsonPath = `${projectRoot}/package.json`;
	let existing: Record<string, unknown> = {};
	try {
		const raw = await fs.readFile(packageJsonPath, 'utf8');
		existing = JSON.parse(raw);
	} catch {
		// No existing package.json — will create one
	}
	existing.name = name;
	await fs.writeFile(packageJsonPath, JSON.stringify(existing, undefined, 2));
}

// =============================================================================
// wrangler.jsonc I/O (asset settings)
// =============================================================================

/**
 * Read asset settings from `wrangler.jsonc` on disk.
 */
export async function readAssetSettings(projectRoot: string): Promise<AssetSettings> {
	try {
		const raw = await fs.readFile(`${projectRoot}/wrangler.jsonc`, 'utf8');
		const parsed: { assets?: AssetSettings } = JSON.parse(stripJsonComments(raw));
		return parsed.assets ?? {};
	} catch {
		return {};
	}
}

/**
 * Write asset settings into `wrangler.jsonc` on disk.
 * Preserves all other fields and regenerates the file.
 */
export async function writeAssetSettings(projectRoot: string, assetSettings: AssetSettings): Promise<void> {
	const projectName = await readProjectName(projectRoot);
	const assetsConfig = resolveAssetSettings(assetSettings);

	await fs.writeFile(
		`${projectRoot}/wrangler.jsonc`,
		JSON.stringify(
			{
				$schema: 'node_modules/wrangler/config-schema.json',
				name: projectName,
				main: 'worker/index.ts',
				compatibility_date: WORKERS_COMPATIBILITY_DATE,
				assets: assetsConfig,
				observability: { enabled: true },
			},
			undefined,
			'\t',
		),
	);
}

// =============================================================================
// Generators
// =============================================================================

/**
 * Generate the contents of `package.json` from project name and dependencies.
 */
function generatePackageJson(projectName: string, filePaths: string[], dependencies: Record<string, string>): string {
	const { hasReact, hasTypeScript, hasTests } = detectProjectFlags(dependencies, filePaths);

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
		dependencies,
		devDependencies,
	};

	return JSON.stringify(packageJson, undefined, 2);
}

/**
 * Generate the contents of `wrangler.jsonc`.
 */
function generateWranglerJsonc(projectName: string, assetSettings: AssetSettings): string {
	const assetsConfig = resolveAssetSettings(assetSettings);

	return JSON.stringify(
		{
			$schema: 'node_modules/wrangler/config-schema.json',
			name: projectName,
			main: 'worker/index.ts',
			compatibility_date: WORKERS_COMPATIBILITY_DATE,
			assets: assetsConfig,
			observability: {
				enabled: true,
			},
		},
		undefined,
		'\t',
	);
}

/**
 * Generate the contents of `vite.config.ts` based on project dependencies.
 */
function generateViteConfig(dependencies: Record<string, string>): string {
	const hasReact = 'react' in dependencies;

	if (hasReact) {
		return `\
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
\tplugins: [react(), cloudflare()],
});
`;
	}

	return `\
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
\tplugins: [cloudflare()],
});
`;
}

/**
 * Generate the contents of `vitest.config.ts`.
 */
function generateVitestConfig(): string {
	return `\
import { defineConfig } from 'vitest/config';

export default defineConfig({
\ttest: {
\t\tglobals: true,
\t\tinclude: ['test/**/*.test.{js,ts,jsx,tsx}', 'src/**/*.test.{js,ts,jsx,tsx}'],
\t},
});
`;
}

// =============================================================================
// Regeneration
// =============================================================================

/**
 * Simple per-root mutex to prevent concurrent regeneration from producing
 * inconsistent files (e.g. two dependency updates racing).
 */
const regenerationLocks = new Map<string, Promise<void>>();

/**
 * Regenerate all protected system files on disk.
 *
 * Reads current project name, dependencies, and asset settings from disk,
 * then rewrites all four system files to keep them in sync.
 *
 * Serialized per project root to prevent concurrent calls from racing.
 */
export async function regenerateProtectedFiles(projectRoot: string): Promise<void> {
	const previous = regenerationLocks.get(projectRoot) ?? Promise.resolve();
	const current = previous.then(() => doRegenerate(projectRoot)).catch(() => doRegenerate(projectRoot));
	regenerationLocks.set(projectRoot, current);
	try {
		await current;
	} finally {
		// Clean up if we're still the latest queued operation
		if (regenerationLocks.get(projectRoot) === current) {
			regenerationLocks.delete(projectRoot);
		}
	}
}

async function doRegenerate(projectRoot: string): Promise<void> {
	const filePaths = await listFilePaths(projectRoot);
	const projectName = await readProjectName(projectRoot);
	const dependencies = await readDependencies(projectRoot);
	const assetSettings = await readAssetSettings(projectRoot);

	await fs.writeFile(`${projectRoot}/package.json`, generatePackageJson(projectName, filePaths, dependencies));
	await fs.writeFile(`${projectRoot}/wrangler.jsonc`, generateWranglerJsonc(projectName, assetSettings));
	await fs.writeFile(`${projectRoot}/vite.config.ts`, generateViteConfig(dependencies));
	await fs.writeFile(`${projectRoot}/vitest.config.ts`, generateVitestConfig());
}

/**
 * Collect relative file paths (no leading slash) for project characteristic detection.
 * Skips protected system files so they don't influence their own regeneration.
 */
async function listFilePaths(directory: string, base = ''): Promise<string[]> {
	const paths: string[] = [];
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const relativePath = base ? `${base}/${entry.name}` : entry.name;
			// Skip protected system files so they don't self-reinforce feature detection
			if (!entry.isDirectory() && PROTECTED_SYSTEM_FILES.has(`/${relativePath}`)) continue;
			if (entry.isDirectory()) {
				paths.push(...(await listFilePaths(`${directory}/${entry.name}`, relativePath)));
			} else {
				paths.push(relativePath);
			}
		}
	} catch {
		// Ignore errors (empty project, etc.)
	}
	return paths;
}
