/**
 * JWT signing for external git access.
 *
 * Signs ES256 (ECDSA with P-256 + SHA-256) tokens using the private key
 * stored in the JWT_PRIVATE_KEY secret.
 *
 * Token format matches jwt.ts expectations:
 * - Header: { alg: "ES256", typ: "JWT" }
 * - Claims: iss, sub, scopes, iat, exp
 */

/** Default token lifetime in seconds (1 hour). */
const DEFAULT_EXPIRY_SECONDS = 3600;

/**
 * Base64url encode a Uint8Array.
 */
function base64UrlEncode(data: Uint8Array): string {
	const base64 = btoa(String.fromCodePoint(...data));
	return base64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Import a PEM-encoded ECDSA P-256 private key for JWT signing.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
	const stripped = pem
		.replace(/-----BEGIN EC PRIVATE KEY-----/, '')
		.replace(/-----END EC PRIVATE KEY-----/, '')
		.replace(/-----BEGIN PRIVATE KEY-----/, '')
		.replace(/-----END PRIVATE KEY-----/, '')
		.replaceAll(/\s/g, '');
	const binaryDer = Uint8Array.from(atob(stripped), (character) => character.codePointAt(0)!);
	return crypto.subtle.importKey('pkcs8', binaryDer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * Sign a JWT for external git access.
 *
 * @param privateKeyPem - PEM-encoded ECDSA P-256 private key
 * @param options - Token claims
 * @returns Signed JWT string and expiration date
 */
export async function signGitJwt(
	privateKeyPem: string,
	options: {
		sub: string;
		scopes: string[];
		expiresInSeconds?: number;
	},
): Promise<{ token: string; expiresAt: string }> {
	const now = Math.floor(Date.now() / 1000);
	const expiresInSeconds = options.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
	const expiresAtUnix = now + expiresInSeconds;

	const header = { alg: 'ES256', typ: 'JWT' };
	const payload = {
		iss: 'worker-ide',
		sub: options.sub,
		scopes: options.scopes,
		iat: now,
		exp: expiresAtUnix,
	};

	const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
	const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
	const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

	const key = await importPrivateKey(privateKeyPem);
	const signatureBuffer = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput);
	const signatureB64 = base64UrlEncode(new Uint8Array(signatureBuffer));

	return {
		token: `${headerB64}.${payloadB64}.${signatureB64}`,
		expiresAt: new Date(expiresAtUnix * 1000).toISOString(),
	};
}
