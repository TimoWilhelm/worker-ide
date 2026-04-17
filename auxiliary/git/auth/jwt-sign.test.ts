import { beforeAll, describe, expect, it } from 'vitest';

import { signGitJwt } from './jwt-sign';
import { verifyJwt } from './jwt';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	return btoa(String.fromCodePoint(...new Uint8Array(buffer)));
}

async function generateKeyPairPem(): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
	const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const privateKeyDer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
	const publicKeyDer = await crypto.subtle.exportKey('spki', keyPair.publicKey);
	const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${arrayBufferToBase64(privateKeyDer)}\n-----END PRIVATE KEY-----`;
	const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${arrayBufferToBase64(publicKeyDer)}\n-----END PUBLIC KEY-----`;
	return { privateKeyPem, publicKeyPem };
}

let privateKeyPem: string;
let publicKeyPem: string;

describe('signGitJwt', () => {
	beforeAll(async () => {
		const keyPair = await generateKeyPairPem();
		privateKeyPem = keyPair.privateKeyPem;
		publicKeyPem = keyPair.publicKeyPem;
	});

	it('produces a token that verifyJwt accepts', async () => {
		const { token, expiresAt } = await signGitJwt(privateKeyPem, {
			sub: 'ide/test-project',
			scopes: ['git:read'],
		});

		expect(token).toContain('.');
		expect(token.split('.')).toHaveLength(3);
		expect(expiresAt).toBeTypeOf('string');
		expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

		const claims = await verifyJwt(token, publicKeyPem);
		expect(claims).toBeDefined();
		expect(claims!.iss).toBe('worker-ide');
		expect(claims!.sub).toBe('ide/test-project');
		expect(claims!.scopes).toEqual(['git:read']);
		expect(claims!.iat).toBeTypeOf('number');
		expect(claims!.exp).toBeTypeOf('number');
	});

	it('supports git:write scope', async () => {
		const { token } = await signGitJwt(privateKeyPem, {
			sub: 'ide/abc123',
			scopes: ['git:read', 'git:write'],
		});

		const claims = await verifyJwt(token, publicKeyPem);
		expect(claims).toBeDefined();
		expect(claims!.scopes).toEqual(['git:read', 'git:write']);
	});

	it('respects custom expiry', async () => {
		const { token, expiresAt } = await signGitJwt(privateKeyPem, {
			sub: 'ide/test',
			scopes: ['git:read'],
			expiresInSeconds: 60,
		});

		const claims = await verifyJwt(token, publicKeyPem);
		expect(claims).toBeDefined();
		const expectedExpiry = Math.floor(Date.now() / 1000) + 60;
		expect(claims!.exp).toBeGreaterThanOrEqual(expectedExpiry - 5);
		expect(claims!.exp).toBeLessThanOrEqual(expectedExpiry + 5);
		expect(Math.abs(new Date(expiresAt).getTime() - claims!.exp * 1000)).toBeLessThan(1000);
	});

	it('fails verification with wrong public key', async () => {
		const { token } = await signGitJwt(privateKeyPem, {
			sub: 'ide/test',
			scopes: ['git:read'],
		});

		const wrongKeyPair = await generateKeyPairPem();
		const claims = await verifyJwt(token, wrongKeyPair.publicKeyPem);
		expect(claims).toBeUndefined();
	});
});
