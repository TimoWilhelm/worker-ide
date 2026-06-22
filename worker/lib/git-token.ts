/**
 * Short-lived, HMAC-signed git access tokens.
 *
 * These gate access to the Artifacts-backed git remote through our own proxy
 * (the `git.<domain>` host). The IDE mints a token scoped to a single project,
 * and the proxy verifies it before minting a real Artifacts token and
 * forwarding the request. The Artifacts token itself never reaches the client.
 *
 * Token format: `<base64url(payload)>.<base64url(hmacSha256)>`
 */

const DEFAULT_TTL_SECONDS = 3600;

export interface GitTokenClaims {
	projectId: string;
	scope: 'read' | 'write';
	/** Expiry as a Unix timestamp in seconds. */
	exp: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCodePoint(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value: string): Uint8Array {
	const padded = value.replaceAll('-', '+').replaceAll('_', '/');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
	return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signGitToken(
	secret: string,
	options: { projectId: string; scope: 'read' | 'write'; ttlSeconds?: number },
): Promise<{ token: string; expiresAt: string }> {
	const exp = Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS);
	const claims: GitTokenClaims = { projectId: options.projectId, scope: options.scope, exp };
	const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));

	const key = await importKey(secret);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	const token = `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;

	return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyGitToken(secret: string, token: string): Promise<GitTokenClaims | undefined> {
	const parts = token.split('.');
	if (parts.length !== 2) return undefined;
	const [payload, signature] = parts;

	const key = await importKey(secret);
	let valid: boolean;
	try {
		valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(signature), new TextEncoder().encode(payload));
	} catch {
		return undefined;
	}
	if (!valid) return undefined;

	let claims: GitTokenClaims;
	try {
		claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
	} catch {
		return undefined;
	}

	if (typeof claims.projectId !== 'string' || (claims.scope !== 'read' && claims.scope !== 'write')) return undefined;
	if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return undefined;

	return claims;
}
