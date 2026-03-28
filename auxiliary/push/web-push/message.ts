import * as base64 from '@stablelib/base64';

import { hkdfGenerate } from './hkdf';
import { cryptoKeysToUint8Array, exportPublicKeyPair, joinUint8Arrays } from './utility';

import type { ApplicationServerKeys, SubscriptionInfo } from './types';

type KeyPairResult = {
	publicKey: CryptoKey;
	privateKey: CryptoKey;
};

function generateSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(16));
}

async function getSubKeyAsCryptoKey(subscription: SubscriptionInfo): Promise<CryptoKey> {
	const key = base64.decodeURLSafe(subscription.key);
	const publicKey = await crypto.subtle.importKey(
		'jwk',
		{
			kty: 'EC',
			crv: 'P-256',
			x: base64.encodeURLSafe(key.slice(1, 33)),
			y: base64.encodeURLSafe(key.slice(33, 65)),
			ext: true,
		},
		{
			name: 'ECDH',
			namedCurve: 'P-256',
		},
		true,
		[],
	);
	return publicKey;
}

async function getSharedSecret(subscription: SubscriptionInfo, serverKeys: KeyPairResult): Promise<ArrayBuffer> {
	const publicKey = await getSubKeyAsCryptoKey(subscription);
	const algorithm = {
		name: 'ECDH',
		namedCurve: 'P-256',
		public: publicKey,
	};
	return crypto.subtle.deriveBits(algorithm, serverKeys.privateKey, 256);
}

async function generateContext(subscription: SubscriptionInfo, serverKeys: KeyPairResult): Promise<Uint8Array> {
	const subKey = await getSubKeyAsCryptoKey(subscription);

	const [clientPublicKey, serverPublicKey] = await Promise.all([
		cryptoKeysToUint8Array(subKey).then((key) => key.publicKey),
		cryptoKeysToUint8Array(serverKeys.publicKey).then((key) => key.publicKey),
	]);

	const labelUnit8Array = new TextEncoder().encode('P-256\u0000');

	const clientPublicKeyLengthUnit8Array = new Uint8Array(2);
	clientPublicKeyLengthUnit8Array[0] = 0x00;
	clientPublicKeyLengthUnit8Array[1] = clientPublicKey.byteLength;

	const serverPublicKeyLengthBuffer = new Uint8Array(2);
	serverPublicKeyLengthBuffer[0] = 0x00;
	serverPublicKeyLengthBuffer[1] = serverPublicKey.byteLength;

	return joinUint8Arrays([labelUnit8Array, clientPublicKeyLengthUnit8Array, clientPublicKey, serverPublicKeyLengthBuffer, serverPublicKey]);
}

async function generatePRK(subscription: SubscriptionInfo, serverKeys: KeyPairResult): Promise<ArrayBuffer> {
	const sharedSecret = await getSharedSecret(subscription, serverKeys);
	const token = 'Content-Encoding: auth\u0000';
	const authInfoUint8Array = new TextEncoder().encode(token);
	return hkdfGenerate(sharedSecret, base64.decodeURLSafe(subscription.auth), authInfoUint8Array, 32);
}

async function generateCEKInfo(subscription: SubscriptionInfo, serverKeys: KeyPairResult): Promise<Uint8Array> {
	const token = 'Content-Encoding: aesgcm\u0000';
	const contentEncoding8Array = new TextEncoder().encode(token);
	const contextBuffer = await generateContext(subscription, serverKeys);
	return joinUint8Arrays([contentEncoding8Array, contextBuffer]);
}

async function generateNonceInfo(subscription: SubscriptionInfo, serverKeys: KeyPairResult): Promise<Uint8Array> {
	const token = 'Content-Encoding: nonce\u0000';
	const contentEncoding8Array = new TextEncoder().encode(token);
	const contextBuffer = await generateContext(subscription, serverKeys);
	return joinUint8Arrays([contentEncoding8Array, contextBuffer]);
}

async function generateEncryptionKeys(
	subscription: SubscriptionInfo,
	salt: Uint8Array,
	serverKeys: KeyPairResult,
): Promise<{ contentEncryptionKey: ArrayBuffer; nonce: ArrayBuffer }> {
	const [prk, cekInfo, nonceInfo] = await Promise.all([
		generatePRK(subscription, serverKeys),
		generateCEKInfo(subscription, serverKeys),
		generateNonceInfo(subscription, serverKeys),
	]);
	const [contentEncryptionKey, nonce] = await Promise.all([hkdfGenerate(prk, salt, cekInfo, 16), hkdfGenerate(prk, salt, nonceInfo, 12)]);
	return { contentEncryptionKey, nonce };
}

async function generateServerKey(): Promise<KeyPairResult> {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- crypto.subtle.generateKey returns CryptoKeyPair but TS types are broader
	return (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as unknown as KeyPairResult;
}

export async function generateAESGCMEncryptedMessage(
	payloadText: string,
	subscription: SubscriptionInfo,
): Promise<{
	cipherText: ArrayBuffer;
	salt: string;
	publicServerKey: string;
}> {
	const salt = generateSalt();
	const serverKeys = await generateServerKey();
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- exportKey with 'jwk' returns JsonWebKey but workerd types are broader
	const exportedServerKey = (await crypto.subtle.exportKey('jwk', serverKeys.publicKey)) as ApplicationServerKeys;
	const encryptionKeys = await generateEncryptionKeys(subscription, salt, serverKeys);
	const contentEncryptionCryptoKey = await crypto.subtle.importKey('raw', encryptionKeys.contentEncryptionKey, 'AES-GCM', false, [
		'decrypt',
		'encrypt',
	]);

	const paddingBytes = 0;
	const paddingUnit8Array = new Uint8Array(2 + paddingBytes);
	const payloadUint8Array = new TextEncoder().encode(payloadText);
	const recordUint8Array = new Uint8Array(paddingUnit8Array.byteLength + payloadUint8Array.byteLength);
	recordUint8Array.set(paddingUnit8Array, 0);
	recordUint8Array.set(payloadUint8Array, paddingUnit8Array.byteLength);

	const encryptedPayloadArrayBuffer = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			tagLength: 128,
			iv: encryptionKeys.nonce,
		},
		contentEncryptionCryptoKey,
		recordUint8Array,
	);

	return {
		cipherText: encryptedPayloadArrayBuffer,
		salt: base64.encodeURLSafe(salt),
		publicServerKey: base64.encodeURLSafe(exportPublicKeyPair(exportedServerKey)),
	};
}
