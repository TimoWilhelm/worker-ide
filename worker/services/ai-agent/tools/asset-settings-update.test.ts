/**
 * Tests for the asset_settings_update tool.
 * Verifies updating asset routing settings in .project-meta.json.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

const memoryFs = createMemoryFs();
vi.mock('node:fs/promises', () => memoryFs.asMock());

vi.mock('../../../lib/durable-object-namespaces', () => ({
	coordinatorNamespace: {
		idFromName: () => ({ toString: () => 'mock-id' }),
		get: () => ({ triggerUpdate: async () => {} }),
	},
}));

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT });
}

function seedMeta(meta: Record<string, unknown>) {
	memoryFs.seedFile(`${PROJECT_ROOT}/.project-meta.json`, JSON.stringify(meta));
}

function readMeta(): Record<string, unknown> {
	const raw = memoryFs.store.get(`${PROJECT_ROOT}/.project-meta.json`);
	return JSON.parse(String(raw?.content ?? '{}'));
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
			seedMeta({ name: 'test', humanId: 'test' });
			const sendEvent = createMockSendEvent();

			const result = await execute({ not_found_handling: 'single-page-application' }, sendEvent, context());

			expect(result.output).toContain('not_found_handling = single-page-application');
			const meta = readMeta();
			expect(meta.assetSettings).toEqual({ not_found_handling: 'single-page-application' });
		});

		it('sets not_found_handling to 404-page', async () => {
			seedMeta({ name: 'test', humanId: 'test' });
			const sendEvent = createMockSendEvent();

			await execute({ not_found_handling: '404-page' }, sendEvent, context());

			const meta = readMeta();
			expect(meta.assetSettings).toEqual({ not_found_handling: '404-page' });
		});

		it('clears not_found_handling when set to none (default)', async () => {
			seedMeta({ name: 'test', humanId: 'test', assetSettings: { not_found_handling: 'single-page-application' } });
			const sendEvent = createMockSendEvent();

			await execute({ not_found_handling: 'none' }, sendEvent, context());

			const meta = readMeta();
			// assetSettings should be removed when empty
			expect(meta.assetSettings).toBeUndefined();
		});

		it('rejects invalid not_found_handling value', async () => {
			seedMeta({ name: 'test', humanId: 'test' });
			const sendEvent = createMockSendEvent();

			await expect(execute({ not_found_handling: 'invalid' }, sendEvent, context())).rejects.toThrow('Invalid not_found_handling');
		});
	});

	describe('html_handling', () => {
		it('sets html_handling to force-trailing-slash', async () => {
			seedMeta({ name: 'test', humanId: 'test' });
			const sendEvent = createMockSendEvent();

			await execute({ html_handling: 'force-trailing-slash' }, sendEvent, context());

			const meta = readMeta();
			expect(meta.assetSettings).toEqual({ html_handling: 'force-trailing-slash' });
		});

		it('clears html_handling when set to auto-trailing-slash (default)', async () => {
			seedMeta({ name: 'test', humanId: 'test', assetSettings: { html_handling: 'none' } });
			const sendEvent = createMockSendEvent();

			await execute({ html_handling: 'auto-trailing-slash' }, sendEvent, context());

			const meta = readMeta();
			expect(meta.assetSettings).toBeUndefined();
		});

		it('rejects invalid html_handling value', async () => {
			seedMeta({ name: 'test', humanId: 'test' });
			const sendEvent = createMockSendEvent();

			await expect(execute({ html_handling: 'invalid' }, sendEvent, context())).rejects.toThrow('Invalid html_handling');
		});
	});

	describe('run_worker_first', () => {
		it('sets run_worker_first to true', async () => {
			seedMeta({ name: 'test', humanId: 'test' });
			const sendEvent = createMockSendEvent();

			await execute({ run_worker_first: 'true' }, sendEvent, context());

			const meta = readMeta();
			expect(meta.assetSettings).toEqual({ run_worker_first: true });
		});

		it('clears run_worker_first when set to false (default)', async () => {
			seedMeta({ name: 'test', humanId: 'test', assetSettings: { run_worker_first: true } });
			const sendEvent = createMockSendEvent();

			await execute({ run_worker_first: 'false' }, sendEvent, context());

			const meta = readMeta();
			expect(meta.assetSettings).toBeUndefined();
		});

		it('sets run_worker_first to route patterns', async () => {
			seedMeta({ name: 'test', humanId: 'test' });
			const sendEvent = createMockSendEvent();

			await execute({ run_worker_first: '/api/*,!/api/docs/*' }, sendEvent, context());

			const meta = readMeta();
			expect(meta.assetSettings).toEqual({ run_worker_first: ['/api/*', '!/api/docs/*'] });
		});

		it('rejects invalid route patterns', async () => {
			seedMeta({ name: 'test', humanId: 'test' });
			const sendEvent = createMockSendEvent();

			await expect(execute({ run_worker_first: 'api/*' }, sendEvent, context())).rejects.toThrow('Patterns must begin with');
		});
	});

	describe('multiple settings', () => {
		it('updates multiple settings at once', async () => {
			seedMeta({ name: 'test', humanId: 'test' });
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

			const meta = readMeta();
			expect(meta.assetSettings).toEqual({
				not_found_handling: 'single-page-application',
				html_handling: 'none',
				run_worker_first: ['/api/*'],
			});
		});
	});

	describe('edge cases', () => {
		it('returns no changes when no settings are provided', async () => {
			seedMeta({ name: 'test', humanId: 'test' });
			const sendEvent = createMockSendEvent();

			const result = await execute({}, sendEvent, context());

			expect(result.output).toContain('No settings were provided');
		});

		it('throws when no meta file exists', async () => {
			const sendEvent = createMockSendEvent();

			await expect(execute({ not_found_handling: 'none' }, sendEvent, context())).rejects.toThrow('No project metadata found');
		});

		it('preserves existing non-asset metadata', async () => {
			seedMeta({ name: 'my-project', humanId: 'cool-id', dependencies: { react: '^19.0.0' } });
			const sendEvent = createMockSendEvent();

			await execute({ not_found_handling: 'single-page-application' }, sendEvent, context());

			const meta = readMeta();
			expect(meta.name).toBe('my-project');
			expect(meta.humanId).toBe('cool-id');
			expect(meta.dependencies).toEqual({ react: '^19.0.0' });
		});
	});
});
