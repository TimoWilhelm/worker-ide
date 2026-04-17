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
				isCSS: true,
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

		await stub.triggerUpdate({ type: 'update', path: '/a.js', timestamp: 1 });
		await stub.sendMessage({ type: 'git-status-changed' });
		await stub.triggerUpdate({ type: 'update', path: '/b.js', timestamp: 2 });

		// Should not throw or corrupt state
		const logs = await stub.getOutputLogs();
		expect(logs).toBe('');
	});
});
