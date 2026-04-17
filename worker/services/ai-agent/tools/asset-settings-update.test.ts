import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

const memoryFs = createMemoryFs();
vi.mock('node:fs/promises', () => memoryFs.asMock());

vi.mock('../../../lib/durable-object-namespaces', () => ({
	coordinatorNamespace: {
		getByName: () => ({ triggerUpdate: async () => {} }),
	},
}));

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT });
}

function seedProject(assetSettings?: Record<string, unknown>) {
	memoryFs.seedFile(`${PROJECT_ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: {} }));
	if (assetSettings) {
		memoryFs.seedFile(`${PROJECT_ROOT}/wrangler.jsonc`, JSON.stringify({ assets: assetSettings }));
	}
}

function readWranglerAssets(): Record<string, unknown> | undefined {
	const raw = memoryFs.store.get(`${PROJECT_ROOT}/wrangler.jsonc`);
	if (!raw) return undefined;
	const parsed: { assets?: Record<string, unknown> } = JSON.parse(String(raw.content));
	return parsed.assets;
}

describe('asset_settings_update', () => {
	let execute: typeof import('./asset-settings-update').execute;

	beforeEach(async () => {
		memoryFs.reset();
		const module = await import('./asset-settings-update');
		execute = module.execute;
	});

	describe('not_found_handling', () => {
		it('sets not_found_handling to single-page-application', async () => {
			seedProject();
			const sendEvent = createMockSendEvent();

			const result = await execute({ not_found_handling: 'single-page-application' }, sendEvent, context());

			expect(result.output).toContain('not_found_handling = single-page-application');
			const assets = readWranglerAssets();
			expect(assets).toBeDefined();
			expect(assets!.not_found_handling).toBe('single-page-application');
		});

		it('sets not_found_handling to 404-page', async () => {
			seedProject();
			const sendEvent = createMockSendEvent();

			await execute({ not_found_handling: '404-page' }, sendEvent, context());

			const assets = readWranglerAssets();
			expect(assets).toBeDefined();
			expect(assets!.not_found_handling).toBe('404-page');
		});

		it('clears not_found_handling when set to none (default)', async () => {
			seedProject({ not_found_handling: 'single-page-application' });
			const sendEvent = createMockSendEvent();

			await execute({ not_found_handling: 'none' }, sendEvent, context());

			const assets = readWranglerAssets();
			expect(assets).toBeDefined();
			// Resolved defaults are written; not_found_handling should be 'none'
			expect(assets!.not_found_handling).toBe('none');
		});

		it('rejects invalid not_found_handling value', async () => {
			seedProject();
			const sendEvent = createMockSendEvent();

			await expect(execute({ not_found_handling: 'invalid' }, sendEvent, context())).rejects.toThrow('Invalid not_found_handling');
		});
	});

	describe('html_handling', () => {
		it('sets html_handling to force-trailing-slash', async () => {
			seedProject();
			const sendEvent = createMockSendEvent();

			await execute({ html_handling: 'force-trailing-slash' }, sendEvent, context());

			const assets = readWranglerAssets();
			expect(assets).toBeDefined();
			expect(assets!.html_handling).toBe('force-trailing-slash');
		});

		it('clears html_handling when set to auto-trailing-slash (default)', async () => {
			seedProject({ html_handling: 'none' });
			const sendEvent = createMockSendEvent();

			await execute({ html_handling: 'auto-trailing-slash' }, sendEvent, context());

			const assets = readWranglerAssets();
			expect(assets).toBeDefined();
			// Resolved defaults are written
			expect(assets!.html_handling).toBe('auto-trailing-slash');
		});

		it('rejects invalid html_handling value', async () => {
			seedProject();
			const sendEvent = createMockSendEvent();

			await expect(execute({ html_handling: 'invalid' }, sendEvent, context())).rejects.toThrow('Invalid html_handling');
		});
	});

	describe('run_worker_first', () => {
		it('sets run_worker_first to true', async () => {
			seedProject();
			const sendEvent = createMockSendEvent();

			await execute({ run_worker_first: 'true' }, sendEvent, context());

			const assets = readWranglerAssets();
			expect(assets).toBeDefined();
			expect(assets!.run_worker_first).toBe(true);
		});

		it('clears run_worker_first when set to false (default)', async () => {
			seedProject({ run_worker_first: true });
			const sendEvent = createMockSendEvent();

			await execute({ run_worker_first: 'false' }, sendEvent, context());

			const assets = readWranglerAssets();
			expect(assets).toBeDefined();
			// Resolved defaults are written
			expect(assets!.run_worker_first).toBe(false);
		});

		it('sets run_worker_first to route patterns', async () => {
			seedProject();
			const sendEvent = createMockSendEvent();

			await execute({ run_worker_first: '/api/*,!/api/docs/*' }, sendEvent, context());

			const assets = readWranglerAssets();
			expect(assets).toBeDefined();
			expect(assets!.run_worker_first).toEqual(['/api/*', '!/api/docs/*']);
		});

		it('rejects invalid route patterns', async () => {
			seedProject();
			const sendEvent = createMockSendEvent();

			await expect(execute({ run_worker_first: 'api/*' }, sendEvent, context())).rejects.toThrow('Patterns must begin with');
		});
	});

	describe('multiple settings', () => {
		it('updates multiple settings at once', async () => {
			seedProject();
			const sendEvent = createMockSendEvent();

			const result = await execute(
				{
					not_found_handling: 'single-page-application',
					html_handling: 'none',
					run_worker_first: '/api/*',
				},
				sendEvent,
				context(),
			);

			expect(result.output).toContain('not_found_handling = single-page-application');
			expect(result.output).toContain('html_handling = none');
			expect(result.output).toContain('run_worker_first = [/api/*]');

			const assets = readWranglerAssets();
			expect(assets).toBeDefined();
			expect(assets!.not_found_handling).toBe('single-page-application');
			expect(assets!.html_handling).toBe('none');
			expect(assets!.run_worker_first).toEqual(['/api/*']);
		});
	});

	describe('edge cases', () => {
		it('returns no changes when no settings are provided', async () => {
			seedProject();
			const sendEvent = createMockSendEvent();

			const result = await execute({}, sendEvent, context());

			expect(result.output).toContain('No settings were provided');
		});

		it('succeeds even when no wrangler.jsonc exists yet', async () => {
			memoryFs.seedFile(`${PROJECT_ROOT}/package.json`, JSON.stringify({ name: 'test', dependencies: {} }));
			const sendEvent = createMockSendEvent();

			const result = await execute({ not_found_handling: 'single-page-application' }, sendEvent, context());

			expect(result.output).toContain('not_found_handling = single-page-application');
			const assets = readWranglerAssets();
			expect(assets).toBeDefined();
			expect(assets!.not_found_handling).toBe('single-page-application');
		});
	});
});
