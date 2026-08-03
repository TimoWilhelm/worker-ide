import { render } from '@react-email/components';
import { WorkerEntrypoint } from 'cloudflare:workers';

import { RateLimiter } from './rate-limiter';
import { EmailVerificationEmail } from './templates/email-verification';
import { OrgInvitationEmail } from './templates/org-invitation';
import { PasswordResetEmail } from './templates/password-reset';

import type { EmailPriority, EmailQueueMessage } from '@shared/notification-types';

export default class EmailWorker extends WorkerEntrypoint<EmailWorkerEnvironment> {
	// Keep queue sends in small bursts while the worker drains messages.
	private rateLimiter = new RateLimiter(2, 60);

	// =========================================================================
	// RPC Methods
	// =========================================================================
	async sendEmail(data: { to: string; subject: string; html: string; replyTo?: string; priority?: EmailPriority }): Promise<void> {
		await this.enqueue(data);
	}
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
			priority: 'normal',
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
			priority: 'high',
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
			priority: 'high',
		});
	}

	// =========================================================================
	// Helpers
	// =========================================================================
	private async enqueue(data: { to: string; subject: string; html: string; replyTo?: string; priority?: EmailPriority }): Promise<void> {
		const message: EmailQueueMessage = {
			from: this.env.EMAIL_FROM,
			to: data.to,
			subject: data.subject,
			html: data.html,
			replyTo: data.replyTo,
			priority: data.priority ?? 'normal',
		};
		const targetQueue = message.priority === 'high' && this.env.EMAIL_HIGH_QUEUE ? this.env.EMAIL_HIGH_QUEUE : this.env.EMAIL_QUEUE;
		await targetQueue.send(message);
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
			let successfulSends = 0;

			for (const message of currentBatch) {
				try {
					await this.env.EMAIL.send(message.body);
					successfulSends += 1;
					message.ack();
				} catch (error) {
					const retryDelay = this.rateLimiter.getErrorRetryDelay();
					console.error(`Unexpected error sending email - retrying with delay: ${retryDelay}s`, error);
					message.retry({ delaySeconds: retryDelay });
				}
			}

			processedCount += currentBatch.length;
			this.rateLimiter.decrementCapacity(successfulSends);
		}
	}
}
