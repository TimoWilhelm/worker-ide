/**
 * Unit tests for protected file generation utilities.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// In-memory filesystem mock
// =============================================================================

const files = new Map<string, string>();

vi.mock('node:fs/promises', () => ({
	default: {
		readFile: async (path: string) => {
			const content = files.get(path);
			if (content === undefined) {
				const error = new Error(`ENOENT: no such file or directory, '${path}'`);
				(error as NodeJS.ErrnoException).code = 'ENOENT';
				throw error;
			}
			return content;
		},
		writeFile: async (path: string, content: string) => {
			files.set(path, content);
		},
		readdir: async (directory: string, options?: { withFileTypes?: boolean }) => {
			const entries: Array<{ name: string; isDirectory: () => boolean }> = [];
			const prefix = directory.endsWith('/') ? directory : `${directory}/`;
			const seen = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				const slashIndex = rest.indexOf('/');
				const name = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
				if (!name || seen.has(name)) continue;
				seen.add(name);
				const isDirectory = slashIndex !== -1;
				entries.push({ name, isDirectory: () => isDirectory });
			}
			if (options?.withFileTypes) return entries;
			return entries.map((entry) => entry.name);
		},
		mkdir: async () => {},
		access: async (path: string) => {
			if (!files.has(path)) {
				const error = new Error(`ENOENT: no such file or directory, '${path}'`);
				(error as NodeJS.ErrnoException).code = 'ENOENT';
				throw error;
			}
		},
	},
}));

// =============================================================================
// Import under test (after mock)
// =============================================================================

const {
	readDependencies,
	writeDependencies,
	readProjectName,
	readAssetSettings,
	writeAssetSettings,
	readBindingsConfig,
	writeBindingsConfig,
	regenerateProtectedFiles,
} = await import('./protected-files');

// =============================================================================
// Tests
// =============================================================================

const ROOT = '/project';

describe('readDependencies', () => {
	beforeEach(() => files.clear());

	it('reads dependencies from package.json', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ dependencies: { hono: '^4.0.0', react: '^19.0.0' } }));

		const result = await readDependencies(ROOT);

		expect(result).toEqual({ hono: '^4.0.0', react: '^19.0.0' });
	});

	it('returns empty object when package.json has empty dependencies', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: {} }));

		const result = await readDependencies(ROOT);

		expect(result).toEqual({});
	});

	it('returns empty object when package.json is missing', async () => {
		const result = await readDependencies(ROOT);

		expect(result).toEqual({});
	});
});

describe('writeDependencies', () => {
	beforeEach(() => files.clear());

	it('writes dependencies to package.json', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', type: 'module', scripts: { dev: 'vite dev' } }));

		await writeDependencies(ROOT, { hono: '^4.0.0' });

		const written = JSON.parse(files.get(`${ROOT}/package.json`)!);
		expect(written.dependencies).toEqual({ hono: '^4.0.0' });
		expect(written.name).toBe('test');
		expect(written.scripts).toEqual({ dev: 'vite dev' });
	});

	it('creates package.json when it does not exist', async () => {
		await writeDependencies(ROOT, { react: '^19.0.0' });

		const written = JSON.parse(files.get(`${ROOT}/package.json`)!);
		expect(written.dependencies).toEqual({ react: '^19.0.0' });
	});
});

describe('readProjectName', () => {
	beforeEach(() => files.clear());

	it('reads name from package.json', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'cool-project', dependencies: {} }));

		const result = await readProjectName(ROOT);

		expect(result).toBe('cool-project');
	});

	it('returns default when package.json is missing', async () => {
		const result = await readProjectName(ROOT);

		expect(result).toBe('my-worker-app');
	});
});

describe('readAssetSettings / writeAssetSettings', () => {
	beforeEach(() => files.clear());

	it('reads asset settings from wrangler.jsonc', async () => {
		files.set(`${ROOT}/wrangler.jsonc`, JSON.stringify({ assets: { not_found_handling: 'single-page-application' } }));

		const result = await readAssetSettings(ROOT);

		expect(result).toEqual({ not_found_handling: 'single-page-application' });
	});

	it('returns empty object when wrangler.jsonc is missing', async () => {
		const result = await readAssetSettings(ROOT);

		expect(result).toEqual({});
	});

	it('writes asset settings to wrangler.jsonc', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test-app', dependencies: {} }));

		await writeAssetSettings(ROOT, { not_found_handling: 'single-page-application' });

		const wrangler = JSON.parse(files.get(`${ROOT}/wrangler.jsonc`)!);
		expect(wrangler.assets.not_found_handling).toBe('single-page-application');
		expect(wrangler.name).toBe('test-app');
	});
});

describe('regenerateProtectedFiles', () => {
	beforeEach(() => files.clear());

	it('generates all five system files', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'my-app', dependencies: { hono: '^4.0.0', react: '^19.0.0' } }));
		files.set(`${ROOT}/src/app.tsx`, '');
		files.set(`${ROOT}/worker/index.ts`, '');
		files.set(`${ROOT}/test/utils.test.ts`, '');

		await regenerateProtectedFiles(ROOT);

		expect(files.has(`${ROOT}/package.json`)).toBe(true);
		expect(files.has(`${ROOT}/wrangler.jsonc`)).toBe(true);
		expect(files.has(`${ROOT}/vite.config.ts`)).toBe(true);
		expect(files.has(`${ROOT}/vitest.config.ts`)).toBe(true);
		expect(files.has(`${ROOT}/worker-env.d.ts`)).toBe(true);
	});

	it('includes project name in package.json and wrangler.jsonc', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'cool-project', dependencies: { hono: '^4.0.0' } }));
		files.set(`${ROOT}/worker/index.ts`, '');

		await regenerateProtectedFiles(ROOT);

		const packageJson = JSON.parse(files.get(`${ROOT}/package.json`)!);
		expect(packageJson.name).toBe('cool-project');

		const wrangler = JSON.parse(files.get(`${ROOT}/wrangler.jsonc`)!);
		expect(wrangler.name).toBe('cool-project');
	});

	it('includes react dev dependencies when react is a dependency', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }));
		files.set(`${ROOT}/src/app.tsx`, '');

		await regenerateProtectedFiles(ROOT);

		const packageJson = JSON.parse(files.get(`${ROOT}/package.json`)!);
		expect(packageJson.devDependencies).toHaveProperty('@types/react');
		expect(packageJson.devDependencies).toHaveProperty('@vitejs/plugin-react');
	});

	it('includes react plugin in vite.config.ts when react is a dependency', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: { react: '^19.0.0' } }));
		files.set(`${ROOT}/src/app.tsx`, '');

		await regenerateProtectedFiles(ROOT);

		const viteConfig = files.get(`${ROOT}/vite.config.ts`)!;
		expect(viteConfig).toContain("import react from '@vitejs/plugin-react'");
		expect(viteConfig).toContain('react()');
	});

	it('omits react plugin in vite.config.ts when react is not a dependency', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: { hono: '^4.0.0' } }));
		files.set(`${ROOT}/worker/index.ts`, '');

		await regenerateProtectedFiles(ROOT);

		const viteConfig = files.get(`${ROOT}/vite.config.ts`)!;
		expect(viteConfig).not.toContain('react');
		expect(viteConfig).toContain('cloudflare()');
	});

	it('includes vitest devDep and test script when test files exist', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: { hono: '^4.0.0' } }));
		files.set(`${ROOT}/test/math.test.ts`, '');

		await regenerateProtectedFiles(ROOT);

		const packageJson = JSON.parse(files.get(`${ROOT}/package.json`)!);
		expect(packageJson.devDependencies).toHaveProperty('vitest');
		expect(packageJson.scripts).toHaveProperty('test', 'vitest run');
	});

	it('preserves existing dependencies through regeneration', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: { hono: '^4.0.0', react: '^19.0.0' } }));
		files.set(`${ROOT}/src/app.tsx`, '');

		await regenerateProtectedFiles(ROOT);

		const packageJson = JSON.parse(files.get(`${ROOT}/package.json`)!);
		expect(packageJson.dependencies).toEqual({ hono: '^4.0.0', react: '^19.0.0' });
	});

	it('reads asset settings from wrangler.jsonc during regeneration', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: {} }));
		files.set(`${ROOT}/wrangler.jsonc`, JSON.stringify({ assets: { not_found_handling: 'single-page-application' } }));

		await regenerateProtectedFiles(ROOT);

		const wrangler = JSON.parse(files.get(`${ROOT}/wrangler.jsonc`)!);
		expect(wrangler.assets.not_found_handling).toBe('single-page-application');
	});

	it('generates worker-env.d.ts with STORAGE binding when storage is enabled', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: {} }));
		files.set(`${ROOT}/wrangler.jsonc`, JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'my-bucket' }] }));

		await regenerateProtectedFiles(ROOT);

		const workerEnvironment = files.get(`${ROOT}/worker-env.d.ts`)!;
		expect(workerEnvironment).toContain('STORAGE: StorageBinding');
		expect(workerEnvironment).toContain('interface StorageBinding');
	});

	it('generates worker-env.d.ts without STORAGE binding when storage is disabled', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: {} }));

		await regenerateProtectedFiles(ROOT);

		const workerEnvironment = files.get(`${ROOT}/worker-env.d.ts`)!;
		expect(workerEnvironment).not.toContain('STORAGE');
		expect(workerEnvironment).toContain('interface Env');
	});

	it('preserves bindings config through regeneration', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: {} }));
		files.set(`${ROOT}/wrangler.jsonc`, JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'my-bucket' }] }));

		await regenerateProtectedFiles(ROOT);

		const wrangler = JSON.parse(files.get(`${ROOT}/wrangler.jsonc`)!);
		expect(wrangler.r2_buckets).toEqual([{ binding: 'STORAGE', bucket_name: 'my-bucket' }]);
	});
});

describe('readBindingsConfig / writeBindingsConfig', () => {
	beforeEach(() => files.clear());

	it('reads bindings config from r2_buckets in wrangler.jsonc', async () => {
		files.set(`${ROOT}/wrangler.jsonc`, JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'my-bucket' }] }));

		const result = await readBindingsConfig(ROOT);

		expect(result).toEqual({ storage: true });
	});

	it('returns empty object when wrangler.jsonc is missing', async () => {
		const result = await readBindingsConfig(ROOT);

		expect(result).toEqual({});
	});

	it('writes bindings config as r2_buckets to wrangler.jsonc', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test-app', dependencies: {} }));

		await writeBindingsConfig(ROOT, { storage: true });

		const wrangler = JSON.parse(files.get(`${ROOT}/wrangler.jsonc`)!);
		expect(wrangler.r2_buckets).toEqual([{ binding: 'STORAGE', bucket_name: 'my-bucket' }]);
		expect(wrangler.bindings).toBeUndefined();
		expect(wrangler.name).toBe('test-app');
	});

	it('omits r2_buckets when no bindings are enabled', async () => {
		files.set(`${ROOT}/package.json`, JSON.stringify({ name: 'test-app', dependencies: {} }));

		await writeBindingsConfig(ROOT, {});

		const wrangler = JSON.parse(files.get(`${ROOT}/wrangler.jsonc`)!);
		expect(wrangler.r2_buckets).toBeUndefined();
	});
});
