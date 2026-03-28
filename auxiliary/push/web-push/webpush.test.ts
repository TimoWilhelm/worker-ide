import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import createFetchMock from 'vitest-fetch-mock';

import { WebPushResult } from './result';
import { generateWebPushMessage } from './webpush';

import type { ApplicationServerKeys, SubscriptionInfo, WebPushMessage } from './types';

const fetchMock = createFetchMock(vi);

const message: WebPushMessage = {
	data: 'test',
	urgency: 'normal',
	sub: 'sub',
	ttl: 3600,
};
const subscription: SubscriptionInfo = {
	auth: 'iEKQbR_pflFFTkifaf3LqA',
	endpoint: 'https://fcm.example.com/fcm/send/1234',
	key: 'BACRqsrr7LH3mVExd_lkMCCoi35Q8uqvBOE45nE_xqXWYvBPrU5LqGAioAZDK9WWtZcQOZgJZa1INR1_hiJueZk',
};
const applicationServerKeys = {
	crv: 'P-256',
	d: 'MM3IEY73Br5_Hdtfknab6QIXqCHXv7S5cZrlD3lrjuk',
	ext: true,
	key_ops: ['sign'],
	kty: 'EC',
	x: 'YNEmMB5QyQULW4WepHQvn5WWrBXpHGFB51eJ3oJj3k4',
	y: 'NU3NCQI82-WvNWc2vc9HV8YOIAC9VsMrMhJhi3XS8MQ',
} satisfies ApplicationServerKeys;

describe('test webpush functions', () => {
	beforeAll(() => {
		fetchMock.enableMocks();
	});
	afterAll(() => {
		fetchMock.disableMocks();
	});
	beforeEach(() => {
		fetchMock.resetMocks();
	});

	test('test successful web push', async () => {
		fetchMock.mockResponseOnce(JSON.stringify({ data: 'ok' }), { status: 200 });
		const { result, response } = await generateWebPushMessage(message, subscription, applicationServerKeys);
		expect(response.status).toBe(200);
		expect(result).toBe(WebPushResult.SUCCESS);
		expect(fetchMock.mock.calls.length).toEqual(1); // one call
		expect(fetchMock.mock.calls[0][0]).toEqual(subscription.endpoint); // the call endpoint was the device endpoint
		expect(fetchMock.mock.calls[0][1]?.method).toEqual('POST'); // the call was a post request
		const headers = fetchMock.mock.calls[0][1]?.headers as unknown as Record<string, string>;
		expect(headers).toBeDefined();
		expect(headers['Content-Type']).toEqual('application/octet-stream'); // the call had a content type header
		const k = headers.Authorization.match(/k=(?<key>[^,]+)/u)?.[1];
		expect(k).toEqual('BGDRJjAeUMkFC1uFnqR0L5-VlqwV6RxhQedXid6CY95ONU3NCQI82-WvNWc2vc9HV8YOIAC9VsMrMhJhi3XS8MQ');
		expect(headers['Content-Encoding']).toEqual('aesgcm');
		expect(Number.parseInt(headers.TTL, 10)).toEqual(message.ttl); // the call had a TTL header
		expect(headers.Urgency).toEqual(message.urgency); // the call had an urgency header
	});

	test.each([400, 401, 404, 410])('test web push not subscribed', async (statusCode) => {
		fetchMock.mockResponseOnce(JSON.stringify({ data: 'push subscription has unsubscribed or expired' }), {
			status: statusCode,
		});
		const { result, response } = await generateWebPushMessage(message, subscription, applicationServerKeys);
		expect(response.status).toBe(statusCode);
		expect(result).toBe(WebPushResult.NOT_SUBSCRIBED);
	});

	test('test web push error', async () => {
		fetchMock.mockResponseOnce('Internal Server Error', { status: 500 });
		const { result, response } = await generateWebPushMessage(message, subscription, applicationServerKeys);
		expect(response.status).toBe(500);
		expect(result).toBe(WebPushResult.ERROR);
	});
});
