import * as base64 from '@stablelib/base64';

import { generateWebPushMessage } from './web-push';

import type { ApplicationServerKeys, SubscriptionInfo } from './web-push';
import type { PushNotification } from '@shared/notification-types';

const DEFAULT_TTL = 60 * 60 * 24 * 7 * 4; // 4 weeks
const WEB_PUSH_TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

export function resolveWebPushTopic(notification: PushNotification): string | undefined {
	const topic = notification.topic ?? notification.tag;
	return WEB_PUSH_TOPIC_PATTERN.test(topic) ? topic : undefined;
}

export function importVapidKeyPair(publicKey: string, privateKey: string): ApplicationServerKeys {
	const publicKeyData = base64.decodeURLSafe(publicKey);
	if (publicKeyData.length !== 65) {
		throw new Error('Invalid public key length');
	}

	const privateKeyData = base64.decodeURLSafe(privateKey);
	if (privateKeyData.length !== 32) {
		throw new Error('Invalid private key length');
	}

	return {
		kty: 'EC',
		crv: 'P-256',
		x: base64.encodeURLSafe(publicKeyData.slice(1, 33)),
		y: base64.encodeURLSafe(publicKeyData.slice(33)),
		d: base64.encodeURLSafe(privateKeyData),
	} satisfies ApplicationServerKeys;
}

export function sendNotification(
	subscription: SubscriptionInfo,
	subject: string,
	applicationServerKeys: ApplicationServerKeys,
	payload: string,
	notification: PushNotification,
): ReturnType<typeof generateWebPushMessage> {
	return generateWebPushMessage(
		{
			data: payload,
			sub: subject,
			ttl: notification.ttl ?? DEFAULT_TTL,
			urgency: notification.urgency ?? 'normal',
			topic: resolveWebPushTopic(notification),
		},
		subscription,
		applicationServerKeys,
	);
}
