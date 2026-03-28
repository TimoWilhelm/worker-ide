/**
 * Push Auxiliary Worker
 *
 * Owns all Web Push notification logic:
 * - Subscription management (register/unregister via KV)
 * - VAPID key provisioning
 * - Push notification sending via Cloudflare Queue
 *
 * The main worker calls this via service binding RPC (env.PUSH.*).
 * Only the actual sending goes through the queue for retries and spike handling.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';

import { importVapidKeyPair, sendNotification } from './push-core';
import { WebPushResult } from './web-push';

import type { ApplicationServerKeys } from './web-push';
import type { PushNotification, PushQueueMessage, PushSubscriptionInfo } from '@shared/notification-types';

// =============================================================================
// Helper: list all KV keys with a prefix (handles pagination)
// =============================================================================

async function listAllKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;

	do {
		const result = await kv.list({ prefix, cursor });
		for (const key of result.keys) {
			keys.push(key.name);
		}
		cursor = result.list_complete ? undefined : result.cursor;
	} while (cursor);

	return keys;
}

// =============================================================================
// WorkerEntrypoint — RPC methods + queue consumer
// =============================================================================

export default class PushWorker extends WorkerEntrypoint<PushWorkerEnvironment> {
	// ---- Cached VAPID keys (initialized on first use) ----
	private applicationServerKeys: ApplicationServerKeys | undefined;

	private getApplicationServerKeys(): ApplicationServerKeys {
		if (!this.applicationServerKeys) {
			this.applicationServerKeys = importVapidKeyPair(this.env.VAPID_PUBLIC_KEY, this.env.VAPID_PRIVATE_KEY);
		}
		return this.applicationServerKeys;
	}

	// =========================================================================
	// RPC Methods
	// =========================================================================

	/** Return the VAPID public key for client-side pushManager.subscribe(). */
	async getVapidPublicKey(): Promise<string> {
		return this.env.VAPID_PUBLIC_KEY;
	}

	/** Store a push subscription in KV keyed by userId/endpointHash. */
	async registerSubscription(userId: string, subscription: PushSubscriptionInfo): Promise<void> {
		const endpointHash = await this.hashEndpoint(subscription.endpoint);
		const key = `${userId}/${endpointHash}`;
		await this.env.KV_PUSH_SUBSCRIPTION.put(key, JSON.stringify(subscription));
	}

	/** Remove a push subscription from KV by userId and endpoint. */
	async unregisterSubscription(userId: string, endpoint: string): Promise<void> {
		const endpointHash = await this.hashEndpoint(endpoint);
		const key = `${userId}/${endpointHash}`;
		await this.env.KV_PUSH_SUBSCRIPTION.delete(key);
	}

	/** Enqueue a push notification for a user. */
	async notifyUser(userId: string, notification: PushNotification): Promise<void> {
		const message: PushQueueMessage = {
			userId,
			tag: notification.tag,
			timestamp: Date.now(),
			title: notification.title,
			body: notification.body,
			path: notification.path,
			ttl: notification.ttl,
		};
		await this.env.PUSH_QUEUE.send(message);
	}

	// =========================================================================
	// Queue Consumer
	// =========================================================================

	async queue(batch: MessageBatch<PushQueueMessage>): Promise<void> {
		const applicationServerKeys = this.getApplicationServerKeys();

		// Collect unique user IDs
		const uniqueUserIds = new Set<string>();
		for (const message of batch.messages) {
			uniqueUserIds.add(message.body.userId);
		}

		// Batch-load subscriptions per user
		const userSubscriptions = new Map<string, Array<{ key: string; subscription: PushSubscriptionInfo }>>();
		await Promise.all(
			[...uniqueUserIds].map(async (userId) => {
				const keys = await listAllKeys(this.env.KV_PUSH_SUBSCRIPTION, `${userId}/`);
				const subscriptions: Array<{ key: string; subscription: PushSubscriptionInfo }> = [];

				await Promise.all(
					keys.map(async (kvKey) => {
						const raw = await this.env.KV_PUSH_SUBSCRIPTION.get(kvKey);
						if (!raw) return;
						try {
							const parsed: unknown = JSON.parse(raw);
							if (typeof parsed === 'object' && parsed !== null && 'endpoint' in parsed && 'key' in parsed && 'auth' in parsed) {
								// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validated above
								subscriptions.push({ key: kvKey, subscription: parsed as PushSubscriptionInfo });
							}
						} catch {
							// Invalid JSON — delete the key
							this.ctx.waitUntil(this.env.KV_PUSH_SUBSCRIPTION.delete(kvKey));
						}
					}),
				);

				userSubscriptions.set(userId, subscriptions);
			}),
		);

		// Send notifications — collect results per subscription, then make a
		// single ack/retry decision per message to avoid calling both on the
		// same queue message when a user has multiple push subscriptions.
		await Promise.all(
			batch.messages.map(async (message) => {
				const { userId, tag, timestamp, title, body, path } = message.body;
				const subscriptions = userSubscriptions.get(userId);

				if (!subscriptions || subscriptions.length === 0) {
					message.ack();
					return;
				}

				const payload = JSON.stringify({ tag, userId, timestamp, title, body, path });

				let anySucceeded = false;
				let anyRetryableError = false;

				await Promise.all(
					subscriptions.map(async ({ key, subscription }) => {
						try {
							const { result, response } = await sendNotification(subscription, this.env.VAPID_SUBJECT, applicationServerKeys, payload, {
								TTL: message.body.ttl,
							});

							switch (result) {
								case WebPushResult.SUCCESS: {
									anySucceeded = true;
									break;
								}
								case WebPushResult.NOT_SUBSCRIBED: {
									console.log(`Invalid subscription, deleting: ${key}`);
									this.ctx.waitUntil(this.env.KV_PUSH_SUBSCRIPTION.delete(key));
									break;
								}
								case WebPushResult.ERROR: {
									console.error(`Web Push error: ${response.status} body: ${await response.text()}`);
									anyRetryableError = true;
									break;
								}
								// no default
							}
						} catch (error) {
							console.error('Error sending push notification', error);
							anyRetryableError = true;
						}
					}),
				);

				// Ack if at least one subscription received the notification
				// successfully, or if all subscriptions were invalid/expired.
				// Retry only if no subscription succeeded and there was a
				// retryable error (and we haven't exhausted attempts).
				if (anySucceeded || !anyRetryableError) {
					message.ack();
				} else if (message.attempts > 5) {
					console.error(`Push notification failed after 5 attempts for user ${userId}`);
					message.ack();
				} else {
					message.retry({ delaySeconds: 5 });
				}
			}),
		);
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private async hashEndpoint(endpoint: string): Promise<string> {
		const data = new TextEncoder().encode(endpoint);
		const hash = await crypto.subtle.digest('SHA-256', data);
		return [...new Uint8Array(hash)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
			.slice(0, 16);
	}
}
