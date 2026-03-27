/**
 * JWT authentication for external git access.
 *
 * Tokens use ES256 (ECDSA with P-256 + SHA-256) and are verified against
 * a public key stored in the JWT_PUBLIC_KEY secret.
 *
 * Token claims:
 * - iss: "worker-ide"
 * - sub: repository ID (e.g. "ide/abc123")
 * - scopes: ["git:read"] or ["git:read", "git:write"]
 * - exp: expiration timestamp (Unix seconds)
 */

export interface JwtClaims {
	iss: string;
	sub: string;
	scopes: string[];
	exp: number;
	iat?: number;
}

/**
 * Import a PEM-encoded ECDSA P-256 public key for JWT verification.
 */
async function importPublicKey(pem: string): Promise<CryptoKey> {
	const stripped = pem
		.replace(/-----BEGIN PUBLIC KEY-----/, '')
		.replace(/-----END PUBLIC KEY-----/, '')
		.replaceAll(/\s/g, '');
	const binaryDer = Uint8Array.from(atob(stripped), (character) => character.codePointAt(0)!);
	return crypto.subtle.importKey('spki', binaryDer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/**
 * Base64url decode to Uint8Array.
 */
function base64UrlDecode(input: string): Uint8Array {
	const padded = input.replaceAll('-', '+').replaceAll('_', '/');
	const padding = '='.repeat((4 - (padded.length % 4)) % 4);
	return Uint8Array.from(atob(padded + padding), (character) => character.codePointAt(0)!);
}

/**
 * Verify a JWT token and return its claims.
 * Returns undefined if the token is invalid or expired.
 */
export async function verifyJwt(token: string, publicKeyPem: string): Promise<JwtClaims | undefined> {
	const parts = token.split('.');
	if (parts.length !== 3) return undefined;

	const [headerB64, payloadB64, signatureB64] = parts;

	try {
		const headerJson = new TextDecoder().decode(base64UrlDecode(headerB64));
		const header = JSON.parse(headerJson) as { alg?: string; typ?: string };
		if (header.alg !== 'ES256' || header.typ !== 'JWT') return undefined;

		const key = await importPublicKey(publicKeyPem);
		const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
		const signature = base64UrlDecode(signatureB64);

		// ES256 signatures are 64 bytes (r || s, each 32 bytes)
		const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data);
		if (!valid) return undefined;

		const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
		const claims = JSON.parse(payloadJson) as JwtClaims;

		// Check expiration
		const now = Math.floor(Date.now() / 1000);
		if (typeof claims.exp !== 'number' || claims.exp < now) return undefined;

		// Validate required fields
		if (claims.iss !== 'worker-ide') return undefined;
		if (!claims.sub || !Array.isArray(claims.scopes)) return undefined;

		return claims;
	} catch {
		return undefined;
	}
}

/**
 * Extract HTTP Basic Auth credentials from a request.
 * Git clients send: Authorization: Basic base64(username:password)
 * We use username "t" (token) and the JWT as the password.
 */
export function extractBasicAuthToken(request: Request): string | undefined {
	const authorization = request.headers.get('Authorization');
	if (!authorization?.startsWith('Basic ')) return undefined;

	try {
		const decoded = atob(authorization.slice(6));
		const colonIndex = decoded.indexOf(':');
		if (colonIndex === -1) return undefined;

		const username = decoded.slice(0, colonIndex);
		const password = decoded.slice(colonIndex + 1);

		// Username must be "t" (for "token")
		if (username !== 't') return undefined;

		return password;
	} catch {
		return undefined;
	}
}

/**
 * Authenticate a git request. Extracts the JWT from Basic Auth,
 * verifies it, and checks that the repo claim matches and the
 * required scope is present.
 */
export async function authenticateGitRequest(
	environment: GitWorkerEnvironment,
	request: Request,
	repoId: string,
	requiredScope: 'git:read' | 'git:write',
): Promise<{ authenticated: boolean; claims?: JwtClaims }> {
	const token = extractBasicAuthToken(request);
	if (!token) return { authenticated: false };

	const claims = await verifyJwt(token, environment.JWT_PUBLIC_KEY);
	if (!claims) return { authenticated: false };

	// Verify repo claim matches
	if (claims.sub !== repoId) return { authenticated: false };

	// Verify scope — git:write implies git:read
	const hasScope = claims.scopes.includes(requiredScope) || (requiredScope === 'git:read' && claims.scopes.includes('git:write'));

	if (!hasScope) return { authenticated: false };

	return { authenticated: true, claims };
}

/**
 * Return a 401 response requesting Basic Auth credentials.
 */
export function unauthorizedResponse(realm = 'git'): Response {
	return new Response('Authentication required\n', {
		status: 401,
		headers: {
			'WWW-Authenticate': `Basic realm="${realm}"`,
			'Content-Type': 'text/plain; charset=utf-8',
		},
	});
}
