/**
 * AES-GCM encryption for Cloudflare OAuth tokens stored at rest in D1.
 *
 * The encryption key is derived from a server secret (e.g. `BETTER_AUTH_SECRET`)
 * via SHA-256, so no extra key management is required. Each ciphertext embeds a
 * fresh random 12-byte IV.
 *
 * Wire format: `base64(iv).base64(ciphertext)`
 */

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;

function base64Encode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCodePoint(byte);
	return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
	return bytes;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return crypto.subtle.importKey('raw', digest, { name: ALGORITHM }, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(secret: string, plaintext: string): Promise<string> {
	const key = await deriveKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, new TextEncoder().encode(plaintext));
	return `${base64Encode(iv)}.${base64Encode(new Uint8Array(ciphertext))}`;
}

export async function decryptToken(secret: string, payload: string): Promise<string | undefined> {
	const parts = payload.split('.');
	if (parts.length !== 2) return undefined;
	const [ivPart, ciphertextPart] = parts;

	try {
		const key = await deriveKey(secret);
		const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv: base64Decode(ivPart) }, key, base64Decode(ciphertextPart));
		return new TextDecoder().decode(plaintext);
	} catch {
		return undefined;
	}
}
