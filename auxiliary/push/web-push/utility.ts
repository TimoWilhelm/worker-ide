import * as base64 from '@stablelib/base64';

import type { ApplicationServerKeys } from './types';

export function exportPublicKeyPair(key: ApplicationServerKeys): Uint8Array {
	return new Uint8Array([0x04, ...base64.decodeURLSafe(key.x), ...base64.decodeURLSafe(key.y)]);
}

export function joinUint8Arrays(allUint8Arrays: Array<Uint8Array>): Uint8Array {
	let totalLength = 0;
	for (const array of allUint8Arrays) {
		totalLength += array.byteLength;
	}
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const array of allUint8Arrays) {
		result.set(array, offset);
		offset += array.byteLength;
	}
	return result;
}

export async function cryptoKeysToUint8Array(
	publicCryptoKey: CryptoKey,
	privateCryptoKey?: CryptoKey,
): Promise<{ publicKey: Uint8Array; privateKey?: Uint8Array }> {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- exportKey with 'jwk' returns JsonWebKey but workerd types return ArrayBuffer | JsonWebKey
	const jwk = (await crypto.subtle.exportKey('jwk', publicCryptoKey)) as JsonWebKey;
	assertApplicationServerKeys(jwk);

	const publicKey = exportPublicKeyPair(jwk);

	if (privateCryptoKey) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- same as above
		const jwkPrivate = (await crypto.subtle.exportKey('jwk', privateCryptoKey)) as JsonWebKey;
		if (!jwkPrivate.d) {
			throw new Error('Private key does not contain a d value');
		}
		const privateKey = base64.decode(jwkPrivate.d);
		return { publicKey, privateKey };
	}

	return { publicKey };
}

function assertApplicationServerKeys(key: JsonWebKey): asserts key is ApplicationServerKeys {
	if (!key.x || !key.y) {
		throw new Error('Public key does not contain x and y values');
	}
}
