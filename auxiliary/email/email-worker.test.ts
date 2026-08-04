import { describe, expect, it, vi } from 'vitest';

import type { EmailQueueMessage } from '@shared/notification-types';

vi.mock('cloudflare:workers', () => ({
	WorkerEntrypoint: class {
		protected env: unknown;

		constructor(_context: unknown, environment: unknown) {
			this.env = environment;
		}
	},
}));

const { default: EmailWorker } = await import('./index');

function createEnvironment() {
	return {
		EMAIL: {
			send: vi.fn(async () => ({ messageId: 'message-123' })),
		},
		EMAIL_QUEUE: {
			send: vi.fn(async () => {}),
		},
		EMAIL_HIGH_QUEUE: {
			send: vi.fn(async () => {}),
		},
		EMAIL_FROM: 'Codemaxxing.ai <noreply@codemaxxing.ai>',
	};
}

function createQueuedMessage(overrides?: Partial<EmailQueueMessage>) {
	const body: EmailQueueMessage = {
		from: 'Codemaxxing.ai <noreply@codemaxxing.ai>',
		to: 'user@example.com',
		subject: 'Verify your email address',
		html: '<p>Hello</p>',
		...overrides,
	};

	return {
		id: 'queue-message-1',
		timestamp: new Date(),
		attempts: 1,
		body,
		ack: vi.fn(),
		retry: vi.fn(),
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

describe('EmailWorker queue consumer', () => {
	it('sends queued emails through the Cloudflare binding and acknowledges them', async () => {
		const environment = createEnvironment();
		const worker = new EmailWorker(createExecutionContext(), environment);
		const message = createQueuedMessage();

		await worker.queue({
			messages: [message],
			queue: 'worker-ide-email',
			retryAll: vi.fn(),
			ackAll: vi.fn(),
		});

		expect(environment.EMAIL.send).toHaveBeenCalledWith(message.body);
		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
	});

	it('retries queued emails when the binding send fails', async () => {
		const environment = createEnvironment();
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			environment.EMAIL.send.mockRejectedValueOnce(new Error('send failed'));
			const worker = new EmailWorker(createExecutionContext(), environment);
			const message = createQueuedMessage();

			await worker.queue({
				messages: [message],
				queue: 'worker-ide-email',
				retryAll: vi.fn(),
				ackAll: vi.fn(),
			});

			expect(message.ack).not.toHaveBeenCalled();
			expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});
});

describe('EmailWorker RPC methods', () => {
	it('routes generic emails to the requested priority queue', async () => {
		const environment = createEnvironment();
		const worker = new EmailWorker(createExecutionContext(), environment);

		await worker.sendEmail({
			to: 'normal@example.com',
			subject: 'Normal email',
			html: '<p>Normal</p>',
		});
		await worker.sendEmail({
			to: 'high@example.com',
			subject: 'High priority email',
			html: '<p>High</p>',
			priority: 'high',
		});

		expect(environment.EMAIL_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'normal@example.com', priority: 'normal' }));
		expect(environment.EMAIL_HIGH_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'high@example.com', priority: 'high' }));
	});

	it('enqueues verification emails with the configured sender', async () => {
		const environment = createEnvironment();
		const worker = new EmailWorker(createExecutionContext(), environment);

		await worker.sendEmailVerification({
			to: 'user@example.com',
			userName: 'Taylor',
			verificationUrl: 'https://example.com/verify',
		});

		expect(environment.EMAIL_HIGH_QUEUE.send).toHaveBeenCalledOnce();

		const queuedMessage = environment.EMAIL_HIGH_QUEUE.send.mock.calls[0]?.[0];
		expect(queuedMessage).toMatchObject({
			from: environment.EMAIL_FROM,
			to: 'user@example.com',
			subject: 'Verify your email address',
			priority: 'high',
		});
		expect(queuedMessage.html).toContain('https://example.com/verify');
	});
});
