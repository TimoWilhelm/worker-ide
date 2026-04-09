/**
 * Protected file generation utilities.
 *
 * System files (package.json, wrangler.jsonc, vite.config.ts, vitest.config.ts, worker-env.d.ts)
 * live in the project filesystem so git can track them. They are regenerated
 * whenever project settings change (name, dependencies, asset settings, bindings).
 *
 * All project configuration is stored in these files directly:
 * - `package.json` — name, dependencies, devDependencies, scripts
 * - `wrangler.jsonc` — name, main, compatibility_date, asset routing settings, bindings config
 * - `vite.config.ts` — Vite plugins (React, Cloudflare)
 * - `vitest.config.ts` — test runner configuration
 * - `worker-env.d.ts` — TypeScript declarations for env bindings (auto-generated from bindings config)
 */

import fs from 'node:fs/promises';

import stripJsonComments from 'strip-json-comments';

import { PROTECTED_SYSTEM_FILES, STORAGE_BINDING_NAME, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { resolveAssetSettings } from '@shared/types';

import type { AssetSettings, BindingsConfig } from '@shared/types';

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
// wrangler.jsonc I/O (asset settings + bindings config)
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
 * Read IDE-managed bindings configuration from `wrangler.jsonc` on disk.
 */
export async function readBindingsConfig(projectRoot: string): Promise<BindingsConfig> {
	try {
		const raw = await fs.readFile(`${projectRoot}/wrangler.jsonc`, 'utf8');
		const parsed: { bindings?: BindingsConfig } = JSON.parse(stripJsonComments(raw));
		return parsed.bindings ?? {};
	} catch {
		return {};
	}
}

/**
 * Write asset settings into `wrangler.jsonc` on disk.
 * Preserves bindings config and regenerates the file.
 */
export async function writeAssetSettings(projectRoot: string, assetSettings: AssetSettings): Promise<void> {
	const projectName = await readProjectName(projectRoot);
	const bindingsConfig = await readBindingsConfig(projectRoot);
	const assetsConfig = resolveAssetSettings(assetSettings);

	await fs.writeFile(
		`${projectRoot}/wrangler.jsonc`,
		JSON.stringify(buildWranglerConfig(projectName, assetsConfig, bindingsConfig), undefined, '\t'),
	);
}

/**
 * Write IDE-managed bindings configuration into `wrangler.jsonc` on disk.
 * Preserves asset settings and regenerates the file.
 */
export async function writeBindingsConfig(projectRoot: string, bindingsConfig: BindingsConfig): Promise<void> {
	const projectName = await readProjectName(projectRoot);
	const assetSettings = await readAssetSettings(projectRoot);
	const assetsConfig = resolveAssetSettings(assetSettings);

	await fs.writeFile(
		`${projectRoot}/wrangler.jsonc`,
		JSON.stringify(buildWranglerConfig(projectName, assetsConfig, bindingsConfig), undefined, '\t'),
	);
}

/**
 * Build the full wrangler.jsonc config object.
 */
function buildWranglerConfig(
	projectName: string,
	assetsConfig: ReturnType<typeof resolveAssetSettings>,
	bindingsConfig: BindingsConfig,
): Record<string, unknown> {
	const config: Record<string, unknown> = {
		$schema: 'node_modules/wrangler/config-schema.json',
		name: projectName,
		main: 'worker/index.ts',
		compatibility_date: WORKERS_COMPATIBILITY_DATE,
		assets: assetsConfig,
		observability: { enabled: true },
	};

	// Only include bindings field if any binding is enabled
	const hasBindings = Object.values(bindingsConfig).some(Boolean);
	if (hasBindings) {
		config.bindings = bindingsConfig;
	}

	return config;
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
function generateWranglerJsonc(projectName: string, assetSettings: AssetSettings, bindingsConfig: BindingsConfig): string {
	const assetsConfig = resolveAssetSettings(assetSettings);

	return JSON.stringify(buildWranglerConfig(projectName, assetsConfig, bindingsConfig), undefined, '\t');
}

/**
 * Generate the contents of `worker-env.d.ts` based on enabled bindings.
 * When no bindings are enabled, generates a minimal Env interface with no extra properties.
 */
function generateWorkerEnvironmentDeclaration(bindingsConfig: BindingsConfig): string {
	const lines: string[] = [];

	if (bindingsConfig.storage) {
		lines.push(
			'interface StorageObject {',
			'\treadonly size: number;',
			'\treadonly contentType: string;',
			'\treadonly uploaded: string;',
			'\treadonly body: ReadableStream;',
			'\ttext(): Promise<string>;',
			'\tarrayBuffer(): Promise<ArrayBuffer>;',
			'\tjson<T = unknown>(): Promise<T>;',
			'}',
			'',
			'interface StorageHeadResult {',
			'\treadonly size: number;',
			'\treadonly contentType: string;',
			'\treadonly uploaded: string;',
			'}',
			'',
			'interface StorageListObject {',
			'\treadonly key: string;',
			'\treadonly size: number;',
			'\treadonly uploaded: string;',
			'}',
			'',
			'interface StorageListResult {',
			'\treadonly objects: StorageListObject[];',
			'\treadonly truncated: boolean;',
			'\treadonly cursor?: string;',
			'}',
			'',
			'interface StorageBinding {',
			'\tput(key: string, value: string | ArrayBuffer | ReadableStream, options?: { contentType?: string }): Promise<void>;',
			'\tget(key: string): Promise<StorageObject | null>;',
			'\tgetText(key: string): Promise<string | null>;',
			'\thead(key: string): Promise<StorageHeadResult | null>;',
			'\tlist(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<StorageListResult>;',
			'\tdelete(key: string | string[]): Promise<void>;',
			'}',
			'',
		);
	}

	const environmentProperties: string[] = [];
	if (bindingsConfig.storage) {
		environmentProperties.push(`\t${STORAGE_BINDING_NAME}: StorageBinding;`);
	}

	lines.push('interface Env {');
	for (const property of environmentProperties) {
		lines.push(property);
	}
	lines.push('}', '');

	return lines.join('\n');
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
 * Reads current project name, dependencies, asset settings, and bindings config
 * from disk, then rewrites all five system files to keep them in sync.
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
	const bindingsConfig = await readBindingsConfig(projectRoot);

	await fs.writeFile(`${projectRoot}/package.json`, generatePackageJson(projectName, filePaths, dependencies));
	await fs.writeFile(`${projectRoot}/wrangler.jsonc`, generateWranglerJsonc(projectName, assetSettings, bindingsConfig));
	await fs.writeFile(`${projectRoot}/vite.config.ts`, generateViteConfig(dependencies));
	await fs.writeFile(`${projectRoot}/vitest.config.ts`, generateVitestConfig());
	await fs.writeFile(`${projectRoot}/worker-env.d.ts`, generateWorkerEnvironmentDeclaration(bindingsConfig));
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
