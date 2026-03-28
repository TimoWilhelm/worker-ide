import * as base64 from '@stablelib/base64';
import { type MockInstance, afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { generateV2Headers } from './vapid';

import type { ApplicationServerKeys } from './types';

describe('test vapid header generation functions', () => {
	let dateNowSpy: MockInstance<() => number>;

	beforeAll(() => {
		dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => 1_487_076_708_000);
	});
	afterAll(() => {
		dateNowSpy.mockRestore();
	});

	test('generateV2Headers', async () => {
		const vapidKeys = {
			crv: 'P-256',
			d: 'MM3IEY73Br5_Hdtfknab6QIXqCHXv7S5cZrlD3lrjuk',
			ext: true,
			key_ops: ['sign'],
			kty: 'EC',
			x: 'YNEmMB5QyQULW4WepHQvn5WWrBXpHGFB51eJ3oJj3k4',
			y: 'NU3NCQI82-WvNWc2vc9HV8YOIAC9VsMrMhJhi3XS8MQ',
		} satisfies ApplicationServerKeys;
		const headers = await generateV2Headers('https://example.com/', vapidKeys, 'abc@email.com');
		// regex extract vapid t=${headers.token}, k=${headers.serverKey}
		const maybeHeader = headers.Authorization.match(/vapid t=(?<token>[^,]+), k=(?<key>[^,]+)/u);
		if (!maybeHeader) {
			throw new Error('no match');
		}
		const [, token, serverKey] = maybeHeader;
		const [header, body, signature] = token.split('.');
		expect(serverKey).toEqual('BGDRJjAeUMkFC1uFnqR0L5-VlqwV6RxhQedXid6CY95ONU3NCQI82-WvNWc2vc9HV8YOIAC9VsMrMhJhi3XS8MQ');

		const textDecoder = new TextDecoder();

		expect(JSON.parse(textDecoder.decode(base64.decode(header)))).toMatchObject({
			typ: 'JWT',
			alg: 'ES256',
		});
		expect(JSON.parse(textDecoder.decode(base64.decode(body)))).toMatchObject({
			aud: 'https://example.com',
			exp: 1_487_119_908,
			sub: 'abc@email.com',
		});

		const publicCryptoKey = await crypto.subtle.importKey(
			'jwk',
			{
				crv: 'P-256',
				ext: true,
				key_ops: ['verify'],
				kty: 'EC',
				x: vapidKeys.x,
				y: vapidKeys.y,
			},
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify'],
		);

		const data = new TextEncoder().encode(`${header}.${body}`);

		await expect(
			crypto.subtle.verify({ name: 'ECDSA', hash: { name: 'SHA-256' } }, publicCryptoKey, base64.decodeURLSafe(signature), data),
		).resolves.toBeTruthy();
	});
});
