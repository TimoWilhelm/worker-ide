/**
 * Tests for the asset_settings_get tool.
 * Verifies reading asset routing settings from .project-meta.json.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

const memoryFs = createMemoryFs();
vi.mock('node:fs/promises', () => memoryFs.asMock());

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT });
}

function seedMeta(meta: Record<string, unknown>) {
	memoryFs.seedFile(`${PROJECT_ROOT}/.project-meta.json`, JSON.stringify(meta));
}

describe('asset_settings_get', () => {
	let execute: typeof import('./asset-settings-get').execute;

	beforeEach(async () => {
		memoryFs.reset();
		const module = await import('./asset-settings-get');
		execute = module.execute;
	});

	it('returns default settings when no asset settings are configured', async () => {
		seedMeta({ name: 'test', humanId: 'test' });

		const sendEvent = createMockSendEvent();
		const result = await execute({}, sendEvent, context());

		expect(result.metadata).toEqual({ assetSettings: {} });
		expect(result.output).toContain('not_found_handling: none');
		expect(result.output).toContain('html_handling: auto-trailing-slash');
		expect(result.output).toContain('run_worker_first: false');
	});

	it('returns configured asset settings', async () => {
		seedMeta({
			name: 'test',
			humanId: 'test',
			assetSettings: {
				not_found_handling: 'single-page-application',
				html_handling: 'force-trailing-slash',
				run_worker_first: ['/api/*', '!/api/docs/*'],
			},
		});

		const sendEvent = createMockSendEvent();
		const result = await execute({}, sendEvent, context());

		expect(result.metadata).toEqual({
			assetSettings: {
				not_found_handling: 'single-page-application',
				html_handling: 'force-trailing-slash',
				run_worker_first: ['/api/*', '!/api/docs/*'],
			},
		});
		expect(result.output).toContain('not_found_handling: single-page-application');
		expect(result.output).toContain('html_handling: force-trailing-slash');
		expect(result.output).toContain('run_worker_first: [/api/*, !/api/docs/*]');
	});

	it('returns run_worker_first as boolean when set to true', async () => {
		seedMeta({
			name: 'test',
			humanId: 'test',
			assetSettings: { run_worker_first: true },
		});

		const sendEvent = createMockSendEvent();
		const result = await execute({}, sendEvent, context());

		expect(result.output).toContain('run_worker_first: true');
	});

	it('returns defaults when no meta file exists', async () => {
		const sendEvent = createMockSendEvent();
		const result = await execute({}, sendEvent, context());

		expect(result.metadata).toEqual({ assetSettings: {} });
		expect(result.output).toContain('No asset settings configured');
	});
});
