import { describe, expect, it, vi } from 'vitest';

import type { PushNotification, PushQueueMessage } from '@shared/notification-types';

vi.mock('cloudflare:workers', () => ({
	WorkerEntrypoint: class {
		protected env: unknown;

		constructor(_context: unknown, environment: unknown) {
			this.env = environment;
		}
	},
}));

const { default: PushWorker } = await import('./index');

function createEnvironment() {
	return {
		PUSH_QUEUE: {
			send: vi.fn(async () => {}),
			sendBatch: vi.fn(async () => {}),
		},
		PUSH_HIGH_QUEUE: {
			send: vi.fn(async () => {}),
			sendBatch: vi.fn(async () => {}),
		},
	};
}

function createExecutionContext() {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
		exports: {},
		props: {},
	};
}

describe('Push notification priority queue routing', () => {
	it('routes high urgency notifications to PUSH_HIGH_QUEUE', async () => {
		const environment = createEnvironment();
		const worker = new PushWorker(createExecutionContext(), environment);
		const notification: PushNotification = {
			title: 'Agent needs your input',
			body: 'Select option A or B',
			tag: 'session-1',
			urgency: 'high',
		};

		await worker.notifyUser('user-1', notification);

		expect(environment.PUSH_HIGH_QUEUE.send).toHaveBeenCalledWith({
			userId: 'user-1',
			notification,
			timestamp: expect.any(Number),
		});
		expect(environment.PUSH_QUEUE.send).not.toHaveBeenCalled();
	});

	it('routes default urgency notifications to PUSH_QUEUE', async () => {
		const environment = createEnvironment();
		const worker = new PushWorker(createExecutionContext(), environment);

		await worker.notifyUser('user-1', {
			title: 'Session complete',
			body: 'Your task has completed.',
			tag: 'session-1',
		});

		expect(environment.PUSH_QUEUE.send).toHaveBeenCalledOnce();
		expect(environment.PUSH_HIGH_QUEUE.send).not.toHaveBeenCalled();
	});

	it('splits batches at the 100 message limit', async () => {
		const environment = createEnvironment();
		const worker = new PushWorker(createExecutionContext(), environment);
		const userIds = Array.from({ length: 201 }, (_, index) => `user-${index}`);

		await worker.notifyUsers(userIds, {
			title: 'Session complete',
			body: 'Your task has completed.',
			tag: 'session-1',
		});

		const batches = environment.PUSH_QUEUE.sendBatch.mock.calls.map(([batch]) => batch);
		expect(batches.map((batch) => batch.length)).toEqual([100, 100, 1]);
		const messages: PushQueueMessage[] = batches.flat().map(({ body }) => body);
		expect(messages.map(({ userId }) => userId)).toEqual(userIds);
		expect(new Set(messages.map(({ timestamp }) => timestamp))).toHaveLength(1);
	});

	it('splits batches before the serialized size limit', async () => {
		const environment = createEnvironment();
		const worker = new PushWorker(createExecutionContext(), environment);

		await worker.notifyUsers(['user-1', 'user-2', 'user-3'], {
			title: 'Large notification',
			body: 'x'.repeat(100 * 1024),
			tag: 'session-1',
		});

		const batches = environment.PUSH_QUEUE.sendBatch.mock.calls.map(([batch]) => batch);
		expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
	});

	it('rejects a message over the per-message size limit', async () => {
		const environment = createEnvironment();
		const worker = new PushWorker(createExecutionContext(), environment);

		await expect(
			worker.notifyUsers(['user-1'], {
				title: 'Oversized notification',
				body: 'x'.repeat(128_000),
				tag: 'session-1',
			}),
		).rejects.toThrow('Push queue message exceeds the 128000 byte limit');
		expect(environment.PUSH_QUEUE.sendBatch).not.toHaveBeenCalled();
	});
});
