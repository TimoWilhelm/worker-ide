import { render } from '@react-email/components';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Resend } from 'resend';

import { RateLimiter } from './rate-limiter';
import { EmailVerificationEmail } from './templates/email-verification';
import { OrgInvitationEmail } from './templates/org-invitation';
import { PasswordResetEmail } from './templates/password-reset';

import type { EmailQueueMessage } from '@shared/notification-types';

export default class EmailWorker extends WorkerEntrypoint<EmailWorkerEnvironment> {
	private resend = new Resend(this.env.RESEND_API_KEY);
	// Rate limiter configured for Resend's default of 2 req/sec
	private rateLimiter = new RateLimiter(2, 60);

	// =========================================================================
	// RPC Methods
	// =========================================================================
	async sendOrgInvitation(data: {
		to: string;
		inviterName: string;
		organizationName: string;
		role: string;
		acceptUrl: string;
	}): Promise<void> {
		const html = await render(
			OrgInvitationEmail({
				inviterName: data.inviterName,
				organizationName: data.organizationName,
				role: data.role,
				acceptUrl: data.acceptUrl,
			}),
		);

		await this.enqueue({
			to: data.to,
			subject: `${data.inviterName} invited you to join ${data.organizationName}`,
			html,
		});
	}
	async sendEmailVerification(data: { to: string; userName: string; verificationUrl: string }): Promise<void> {
		const html = await render(
			EmailVerificationEmail({
				userName: data.userName,
				verificationUrl: data.verificationUrl,
			}),
		);

		await this.enqueue({
			to: data.to,
			subject: 'Verify your email address',
			html,
		});
	}
	async sendPasswordReset(data: { to: string; userName: string; resetUrl: string }): Promise<void> {
		const html = await render(
			PasswordResetEmail({
				userName: data.userName,
				resetUrl: data.resetUrl,
			}),
		);

		await this.enqueue({
			to: data.to,
			subject: 'Reset your password',
			html,
		});
	}

	// =========================================================================
	// Helpers
	// =========================================================================
	private async enqueue(data: { to: string; subject: string; html: string; replyTo?: string }): Promise<void> {
		const message: EmailQueueMessage = {
			from: this.env.EMAIL_FROM,
			to: data.to,
			subject: data.subject,
			html: data.html,
			replyTo: data.replyTo,
		};
		await this.env.EMAIL_QUEUE.send(message);
	}

	// =========================================================================
	// Queue Consumer
	// =========================================================================

	async queue(batch: MessageBatch<EmailQueueMessage>): Promise<void> {
		let processedCount = 0;

		while (processedCount < batch.messages.length) {
			const batchSize = this.rateLimiter.calculateBatchSize(batch.messages.length - processedCount);

			if (batchSize === 0) {
				const remainingMessages = batch.messages.slice(processedCount);
				const retryDelay = this.rateLimiter.getCapacityExhaustedDelay();
				const state = this.rateLimiter.getState();
				console.warn(
					`Rate limit capacity exhausted (limit: ${state.maxConcurrent}, remaining: ${state.remainingInWindow}). ` +
						`Retrying ${remainingMessages.length} messages with delay: ${retryDelay}s`,
				);
				for (const remainingMessage of remainingMessages) {
					remainingMessage.retry({ delaySeconds: retryDelay });
				}
				break;
			}

			const currentBatch = batch.messages.slice(processedCount, processedCount + batchSize);
			const results = await Promise.allSettled(
				currentBatch.map(async (message) => {
					try {
						const sendEmail = await this.resend.emails.send(message.body, {
							idempotencyKey: message.id,
						});
						return { message, sendEmail } as const;
					} catch (error) {
						return { message, error } as const;
					}
				}),
			);

			let hitRateLimit = false;
			let successfulSends = 0;

			for (const result of results) {
				if (result.status === 'rejected') {
					console.error('Unexpected promise rejection', result.reason);
					continue;
				}

				if (result.value.sendEmail === undefined) {
					const { message, error } = result.value;
					const retryDelay = this.rateLimiter.getErrorRetryDelay();
					console.error(`Unexpected error sending email - retrying with delay: ${retryDelay}s`, error);
					message.retry({ delaySeconds: retryDelay });
					continue;
				}

				const { message, sendEmail } = result.value;

				this.rateLimiter.processResponse({
					headers: sendEmail.headers ?? undefined,
					is429: sendEmail.error?.statusCode === 429,
				});

				if (sendEmail.error === null) {
					successfulSends += 1;
					message.ack();
					continue;
				}

				if (sendEmail.error.statusCode === 429) {
					hitRateLimit = true;
					const retry429Delay = this.rateLimiter.get429RetryDelay(sendEmail.headers ?? undefined);
					console.warn(`Resend rate limit exceeded. Retrying with delay: ${retry429Delay}s`);
					message.retry({ delaySeconds: retry429Delay });
					continue;
				}

				const retryDelay = this.rateLimiter.getErrorRetryDelay();
				console.error(`Email send failed (status: ${sendEmail.error.statusCode}) - retrying with delay: ${retryDelay}s`, sendEmail.error);
				message.retry({ delaySeconds: retryDelay });
			}

			processedCount += currentBatch.length;
			this.rateLimiter.decrementCapacity(successfulSends);

			if (hitRateLimit && processedCount < batch.messages.length) {
				const remainingMessages = batch.messages.slice(processedCount);
				const retryDelay = this.rateLimiter.get429RetryDelay();
				console.warn(`Retrying ${remainingMessages.length} remaining messages with delay: ${retryDelay}s`);
				for (const remainingMessage of remainingMessages) {
					remainingMessage.retry({ delaySeconds: retryDelay });
				}
				break;
			}
		}
	}
}
