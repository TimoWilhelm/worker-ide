import { DurableObjectFilesystem } from 'durable-object-fs';

import { PROJECT_EXPIRATION_DAYS } from '@shared/constants';

/**
 * Project expiration duration in milliseconds.
 * Projects unused for this duration will be automatically deleted.
 */
const PROJECT_EXPIRATION_MS = PROJECT_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Extended DurableObjectFilesystem that adds automatic expiration for unused projects.
 *
 * Projects are automatically deleted after PROJECT_EXPIRATION_MS of inactivity.
 * Each access to the project resets the expiration timer.
 *
 * The expiration is implemented using Durable Object alarms, which means:
 * - No external registry is needed
 * - Each project manages its own expiration
 * - Expiration works even if no scheduled workers are configured
 */
export class ExpiringFilesystem extends DurableObjectFilesystem {
	/**
	 * Refresh the expiration alarm. This should be called on every project access.
	 * Sets an alarm for PROJECT_EXPIRATION_MS from now.
	 */
	async refreshExpiration(): Promise<void> {
		await this.ctx.storage.deleteAlarm();

		const expirationTime = Date.now() + PROJECT_EXPIRATION_MS;
		await this.ctx.storage.setAlarm(expirationTime);
	}

	/**
	 * Get the current expiration time, if set.
	 * @returns The expiration timestamp in milliseconds, or null if no alarm is set
	 */
	async getExpirationTime(): Promise<number | null> {
		return await this.ctx.storage.getAlarm();
	}

	/**
	 * Alarm handler - called when the expiration alarm fires.
	 * Deletes all data in this Durable Object, effectively removing the project.
	 */
	async alarm(): Promise<void> {
		// Delete all data in this Durable Object
		await this.ctx.storage.deleteAll();
		console.log(`Project expired and deleted at ${new Date().toISOString()}`);
	}
}
