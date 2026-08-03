import { generateAESGCMEncryptedMessage } from './message';
import { WebPushResult } from './result';
import { generateV2Headers } from './vapid';

import type { WebPushResultType } from './result';
import type { ApplicationServerKeys, SubscriptionInfo, WebPushMessage } from './types';

export async function generateWebPushMessage(
	message: WebPushMessage,
	subscription: SubscriptionInfo,
	applicationServerKeys: ApplicationServerKeys,
): Promise<{
	result: WebPushResultType;
	response: Response;
}> {
	const [authHeaders, encryptedPayloadDetails] = await Promise.all([
		generateV2Headers(subscription.endpoint, applicationServerKeys, message.sub),
		generateAESGCMEncryptedMessage(message.data, subscription),
	]);

	const headers: { [headerName: string]: string } = {
		...authHeaders,
		Encryption: `salt=${encryptedPayloadDetails.salt}`,
		'Crypto-Key': `dh=${encryptedPayloadDetails.publicServerKey}`,
		'Content-Encoding': 'aesgcm',
		'Content-Type': 'application/octet-stream',
		TTL: `${message.ttl}`,
		Urgency: `${message.urgency}`,
	};

	if (message.topic) {
		headers.Topic = message.topic;
	}

	const response = await fetch(subscription.endpoint, {
		method: 'POST',
		headers,
		body: encryptedPayloadDetails.cipherText,
	});

	if (response.ok) {
		return {
			result: WebPushResult.SUCCESS,
			response,
		};
	}

	switch (response.status) {
		case 400: // http bad request
		case 401: // http unauthorized
		case 403: // http forbidden
		case 404: // http not found
		case 410: {
			// http gone
			return {
				result: WebPushResult.NOT_SUBSCRIBED,
				response,
			};
		}

		default: {
			return {
				result: WebPushResult.ERROR,
				response,
			};
		}
	}
}
