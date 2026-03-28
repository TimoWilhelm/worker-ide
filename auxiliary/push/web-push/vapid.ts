import * as base64 from '@stablelib/base64';

import { exportPublicKeyPair } from './utility';

import type { ApplicationServerKeys } from './types';

const objectToUrlBase64 = (object: Record<string, unknown>) => base64.encodeURLSafe(new TextEncoder().encode(JSON.stringify(object)));

async function signData(token: string, applicationKeys: ApplicationServerKeys): Promise<string> {
	const key = await crypto.subtle.importKey('jwk', applicationKeys, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, key, new TextEncoder().encode(token));

	return base64.encodeURLSafe(new Uint8Array(signature));
}

async function generateHeaders(
	endpoint: string,
	applicationServerKeys: ApplicationServerKeys,
	sub: string,
): Promise<{ token: string; serverKey: string }> {
	const serverKey = trimPadding(base64.encodeURLSafe(exportPublicKeyPair(applicationServerKeys)));
	const pushService = new URL(endpoint);

	const header = {
		typ: 'JWT',
		alg: 'ES256',
	};

	const body = {
		aud: `${pushService.protocol}//${pushService.host}`,
		exp: Math.trunc(Date.now() / 1000) + 12 * 60 * 60,
		sub: String(sub),
	};

	const unsignedToken = `${trimPadding(objectToUrlBase64(header))}.${trimPadding(objectToUrlBase64(body))}`;
	const signature = trimPadding(await signData(unsignedToken, applicationServerKeys));
	const token = `${unsignedToken}.${signature}`;
	return { token, serverKey };
}

export async function generateV2Headers(
	endpoint: string,
	applicationServerKeys: ApplicationServerKeys,
	sub: string,
): Promise<{ [headerName in 'Authorization']: string }> {
	const headers = await generateHeaders(endpoint, applicationServerKeys, sub);
	return { Authorization: `vapid t=${headers.token}, k=${headers.serverKey}` };
}

function trimPadding(s: string): string {
	// padding ("=") must be omitted as per https://tools.ietf.org/html/rfc7515#section-2
	return s.replaceAll(/=+$/gu, '');
}
