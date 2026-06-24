import { describe, expect, it } from 'vitest';

import { decryptToken, encryptToken } from './cloudflare-oauth-crypto';

const SECRET = 'test-secret-key-1234567890';

describe('cloudflare-oauth-crypto', () => {
	it('round-trips a token', async () => {
		const plaintext = 'cf-access-token-value';
		const encrypted = await encryptToken(SECRET, plaintext);
		expect(encrypted).not.toBe(plaintext);
		expect(encrypted).toContain('.');
		expect(await decryptToken(SECRET, encrypted)).toBe(plaintext);
	});

	it('produces a different ciphertext each time (random IV)', async () => {
		const a = await encryptToken(SECRET, 'same-value');
		const b = await encryptToken(SECRET, 'same-value');
		expect(a).not.toBe(b);
		expect(await decryptToken(SECRET, a)).toBe('same-value');
		expect(await decryptToken(SECRET, b)).toBe('same-value');
	});

	it('fails to decrypt with the wrong secret', async () => {
		const encrypted = await encryptToken(SECRET, 'secret-value');
		expect(await decryptToken('a-different-secret', encrypted)).toBeUndefined();
	});

	it('returns undefined for malformed payloads', async () => {
		expect(await decryptToken(SECRET, 'not-a-valid-payload')).toBeUndefined();
		expect(await decryptToken(SECRET, 'aaa.bbb')).toBeUndefined();
	});

	it('returns undefined for tampered ciphertext', async () => {
		const encrypted = await encryptToken(SECRET, 'secret-value');
		const [iv, ciphertext] = encrypted.split('.');
		const tampered = `${iv}.${ciphertext.slice(0, -2)}AA`;
		expect(await decryptToken(SECRET, tampered)).toBeUndefined();
	});
});
