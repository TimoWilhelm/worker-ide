import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectCoordinatorV2 } from './project-coordinator';

/**
 * Get a fresh ProjectCoordinatorV2 stub for testing.
 * Each call with a different name gets an isolated DO instance.
 */
function getCoordinatorStub(name: string): DurableObjectStub<ProjectCoordinatorV2> {
	const namespace = env.ProjectCoordinatorV2 as DurableObjectNamespace<ProjectCoordinatorV2>;
	return namespace.getByName(name);
}

describe('getOutputLogs', () => {
	it('returns empty string initially', async () => {
		const stub = getCoordinatorStub('test-output-logs-empty');
		const logs = await stub.getOutputLogs();
		expect(logs).toBe('');
	});
});

describe('sendMessage', () => {
	it('does not throw when no clients are connected', async () => {
		const stub = getCoordinatorStub('test-send-no-clients');
		await expect(
			stub.sendMessage({
				type: 'server-error',
				error: { id: 'e1', type: 'runtime', message: 'test error', timestamp: Date.now() },
			}),
		).resolves.toBeUndefined();
	});

	it('does not throw for non-error messages', async () => {
		const stub = getCoordinatorStub('test-send-non-error');
		await expect(
			stub.sendMessage({
				type: 'git-status-changed',
			}),
		).resolves.toBeUndefined();
	});
});

describe('triggerUpdate', () => {
	it('does not throw when no clients are connected', async () => {
		const stub = getCoordinatorStub('test-trigger-no-clients');
		await expect(
			stub.triggerUpdate({
				type: 'update',
				path: '/test.js',
				timestamp: Date.now(),
				targets: [{ id: '/test.js', kind: 'module' }],
			}),
		).resolves.toBeUndefined();
	});

	it('does not throw for full-reload updates', async () => {
		const stub = getCoordinatorStub('test-trigger-full-reload');
		await expect(
			stub.triggerUpdate({
				type: 'full-reload',
				path: '*',
				timestamp: Date.now(),
				targets: [],
			}),
		).resolves.toBeUndefined();
	});

	it('does not throw for CSS updates', async () => {
		const stub = getCoordinatorStub('test-trigger-css');
		await expect(
			stub.triggerUpdate({
				type: 'update',
				path: '/style.css',
				timestamp: Date.now(),
				targets: [
					{ id: '/style.css', kind: 'style-link' },
					{ id: '/style.css?mode=module', kind: 'module' },
				],
			}),
		).resolves.toBeUndefined();
	});
});

describe('output logs persistence', () => {
	it('getOutputLogs returns empty string when only non-log messages sent', async () => {
		const stub = getCoordinatorStub('test-output-no-logs');

		// Send a server-error (this goes to lastServerError, not outputLogs)
		await stub.sendMessage({
			type: 'server-error',
			error: { id: 'e2', type: 'bundle', message: 'Build failed', timestamp: 1234 },
		});

		const logs = await stub.getOutputLogs();
		expect(logs).toBe('');
	});
});

describe('external change buffering', () => {
	it('deduplicates repeated file edits by path and keeps the latest timestamp', async () => {
		const stub = getCoordinatorStub('test-external-file-edits');

		await stub.recordExternalChange({ kind: 'file-edit', path: '/src/index.ts', timestamp: 10 });
		await stub.recordExternalChange({ kind: 'file-edit', path: '/src/index.ts', timestamp: 20 });
		await stub.recordExternalChange({ kind: 'file-edit', path: '/src/other.ts', timestamp: 15 });

		const changes = await stub.getRecentExternalChanges();
		expect(changes).toEqual([
			{ kind: 'file-edit', path: '/src/other.ts', timestamp: 15 },
			{ kind: 'file-edit', path: '/src/index.ts', timestamp: 20 },
		]);

		expect(await stub.getRecentExternalChanges()).toEqual([]);
	});

	it('merges Wrangler settings updates into one semantic change entry', async () => {
		const stub = getCoordinatorStub('test-external-wrangler-settings');

		await stub.recordExternalChange({
			kind: 'wrangler-settings',
			path: '/wrangler.jsonc',
			timestamp: 30,
			domains: ['asset-settings'],
			assetSettings: {
				not_found_handling: 'single-page-application',
				html_handling: 'drop-trailing-slash',
			},
		});
		await stub.recordExternalChange({
			kind: 'wrangler-settings',
			path: '/wrangler.jsonc',
			timestamp: 40,
			domains: ['bindings-config'],
			bindingsConfig: { storage: true },
		});

		const changes = await stub.getRecentExternalChanges();
		expect(changes).toEqual([
			{
				kind: 'wrangler-settings',
				path: '/wrangler.jsonc',
				timestamp: 40,
				domains: ['asset-settings', 'bindings-config'],
				assetSettings: {
					not_found_handling: 'single-page-application',
					html_handling: 'drop-trailing-slash',
				},
				bindingsConfig: { storage: true },
			},
		]);
	});
});

describe('instance consistency', () => {
	it('multiple RPC calls on the same stub work correctly', async () => {
		const stub = getCoordinatorStub('test-instance-consistency');

		// Multiple sendMessage calls should not interfere with each other
		await stub.sendMessage({ type: 'git-status-changed' });
		await stub.sendMessage({ type: 'git-status-changed' });

		// getOutputLogs should still return empty (unrelated to sendMessage)
		const logs = await stub.getOutputLogs();
		expect(logs).toBe('');
	});

	it('triggerUpdate and sendMessage work on the same instance', async () => {
		const stub = getCoordinatorStub('test-mixed-rpc');

		await stub.triggerUpdate({ type: 'update', path: '/a.js', timestamp: 1, targets: [{ id: '/a.js', kind: 'module' }] });
		await stub.sendMessage({ type: 'git-status-changed' });
		await stub.triggerUpdate({ type: 'update', path: '/b.js', timestamp: 2, targets: [{ id: '/b.js', kind: 'module' }] });

		// Should not throw or corrupt state
		const logs = await stub.getOutputLogs();
		expect(logs).toBe('');
	});
});
