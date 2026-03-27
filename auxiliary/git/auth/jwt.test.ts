/**
 * Tests for JWT authentication module.
 *
 * Tests cover:
 * - JWT verification with ES256 (ECDSA P-256 + SHA-256)
 * - HTTP Basic Auth token extraction
 * - Full authentication flow (repo + scope matching)
 * - Edge cases (expired, malformed, wrong scope, wrong repo)
 */

import { describe, expect, it } from 'vitest';

import { authenticateGitRequest, extractBasicAuthToken, unauthorizedResponse, verifyJwt } from './jwt';

// =============================================================================
// Test helpers — generate real ES256 key pair and sign JWTs
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CryptoKey is from Web Crypto API
async function generateKeyPair(): Promise<{ publicKey: string; privateKey: any }> {
	const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

	// Export public key as PEM
	const publicKeyDer = await crypto.subtle.exportKey('spki', keyPair.publicKey);
	const publicKeyBase64 = btoa(String.fromCodePoint(...new Uint8Array(publicKeyDer)));
	const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----`;

	return { publicKey: publicKeyPem, privateKey: keyPair.privateKey };
}

function base64UrlEncode(data: Uint8Array | string): string {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	return btoa(String.fromCodePoint(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function signJwt(claims: Record<string, unknown>, privateKey: any): Promise<string> {
	const header = { alg: 'ES256', typ: 'JWT' };
	const headerB64 = base64UrlEncode(JSON.stringify(header));
	const payloadB64 = base64UrlEncode(JSON.stringify(claims));
	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);

	return `${headerB64}.${payloadB64}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// =============================================================================
// extractBasicAuthToken
// =============================================================================

describe('extractBasicAuthToken', () => {
	it('extracts token from valid Basic auth with username "t"', () => {
		const encoded = btoa('t:my-jwt-token');
		const request = new Request('https://example.com', {
			headers: { Authorization: `Basic ${encoded}` },
		});

		expect(extractBasicAuthToken(request)).toBe('my-jwt-token');
	});

	it('returns undefined when username is not "t"', () => {
		const encoded = btoa('admin:my-jwt-token');
		const request = new Request('https://example.com', {
			headers: { Authorization: `Basic ${encoded}` },
		});

		expect(extractBasicAuthToken(request)).toBeUndefined();
	});

	it('returns undefined when no Authorization header', () => {
		const request = new Request('https://example.com');
		expect(extractBasicAuthToken(request)).toBeUndefined();
	});

	it('returns undefined for Bearer auth', () => {
		const request = new Request('https://example.com', {
			headers: { Authorization: 'Bearer some-token' },
		});

		expect(extractBasicAuthToken(request)).toBeUndefined();
	});

	it('returns undefined for malformed Basic auth (no colon)', () => {
		const encoded = btoa('no-colon-here');
		const request = new Request('https://example.com', {
			headers: { Authorization: `Basic ${encoded}` },
		});

		expect(extractBasicAuthToken(request)).toBeUndefined();
	});

	it('handles passwords containing colons', () => {
		const encoded = btoa('t:token:with:colons');
		const request = new Request('https://example.com', {
			headers: { Authorization: `Basic ${encoded}` },
		});

		expect(extractBasicAuthToken(request)).toBe('token:with:colons');
	});

	it('returns undefined for empty Authorization header', () => {
		const request = new Request('https://example.com', {
			headers: { Authorization: '' },
		});

		expect(extractBasicAuthToken(request)).toBeUndefined();
	});
});

// =============================================================================
// verifyJwt
// =============================================================================

describe('verifyJwt', () => {
	it('verifies a valid JWT', async () => {
		const { publicKey, privateKey } = await generateKeyPair();
		const token = await signJwt(
			{
				iss: 'worker-ide',
				sub: 'ide/test-project',
				scopes: ['git:read', 'git:write'],
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			privateKey,
		);

		const claims = await verifyJwt(token, publicKey);

		expect(claims).toBeDefined();
		expect(claims!.sub).toBe('ide/test-project');
		expect(claims!.scopes).toContain('git:read');
		expect(claims!.scopes).toContain('git:write');
	});

	it('rejects expired tokens', async () => {
		const { publicKey, privateKey } = await generateKeyPair();
		const token = await signJwt(
			{
				iss: 'worker-ide',
				sub: 'ide/test',
				scopes: ['git:read'],
				exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
			},
			privateKey,
		);

		expect(await verifyJwt(token, publicKey)).toBeUndefined();
	});

	it('rejects tokens with wrong signature', async () => {
		const { publicKey } = await generateKeyPair();
		const { privateKey: wrongKey } = await generateKeyPair();
		const token = await signJwt(
			{
				iss: 'worker-ide',
				sub: 'ide/test',
				scopes: ['git:read'],
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			wrongKey,
		);

		expect(await verifyJwt(token, publicKey)).toBeUndefined();
	});

	it('rejects malformed tokens (not 3 parts)', async () => {
		const { publicKey } = await generateKeyPair();

		expect(await verifyJwt('not-a-jwt', publicKey)).toBeUndefined();
		expect(await verifyJwt('two.parts', publicKey)).toBeUndefined();
		expect(await verifyJwt('a.b.c.d', publicKey)).toBeUndefined();
	});

	it('rejects tokens missing required fields', async () => {
		const { publicKey, privateKey } = await generateKeyPair();
		const token = await signJwt(
			{
				iss: 'worker-ide',
				// missing sub and scopes
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			privateKey,
		);

		expect(await verifyJwt(token, publicKey)).toBeUndefined();
	});

	it('rejects tokens with wrong issuer', async () => {
		const { publicKey, privateKey } = await generateKeyPair();
		const token = await signJwt(
			{
				iss: 'other-service',
				sub: 'ide/test',
				scopes: ['git:read'],
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			privateKey,
		);

		expect(await verifyJwt(token, publicKey)).toBeUndefined();
	});

	it('rejects tokens where scopes is not an array', async () => {
		const { publicKey, privateKey } = await generateKeyPair();
		const token = await signJwt(
			{
				iss: 'worker-ide',
				sub: 'ide/test',
				scopes: 'git:read', // string, not array
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			privateKey,
		);

		expect(await verifyJwt(token, publicKey)).toBeUndefined();
	});
});

// =============================================================================
// authenticateGitRequest
// =============================================================================

describe('authenticateGitRequest', () => {
	it('authenticates a valid read request', async () => {
		const { publicKey, privateKey } = await generateKeyPair();
		const token = await signJwt(
			{
				iss: 'worker-ide',
				sub: 'ide/project-123',
				scopes: ['git:read'],
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			privateKey,
		);

		const encoded = btoa(`t:${token}`);
		const request = new Request('https://example.com', {
			headers: { Authorization: `Basic ${encoded}` },
		});

		const environment = { JWT_PUBLIC_KEY: publicKey } as unknown as GitWorkerEnvironment;
		const result = await authenticateGitRequest(environment, request, 'ide/project-123', 'git:read');

		expect(result.authenticated).toBe(true);
		expect(result.claims).toBeDefined();
	});

	it('rejects when repo claim does not match', async () => {
		const { publicKey, privateKey } = await generateKeyPair();
		const token = await signJwt(
			{
				iss: 'worker-ide',
				sub: 'ide/other-project',
				scopes: ['git:read'],
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			privateKey,
		);

		const encoded = btoa(`t:${token}`);
		const request = new Request('https://example.com', {
			headers: { Authorization: `Basic ${encoded}` },
		});

		const environment = { JWT_PUBLIC_KEY: publicKey } as unknown as GitWorkerEnvironment;
		const result = await authenticateGitRequest(environment, request, 'ide/project-123', 'git:read');

		expect(result.authenticated).toBe(false);
	});

	it('rejects when required scope is missing', async () => {
		const { publicKey, privateKey } = await generateKeyPair();
		const token = await signJwt(
			{
				iss: 'worker-ide',
				sub: 'ide/project-123',
				scopes: ['git:read'],
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			privateKey,
		);

		const encoded = btoa(`t:${token}`);
		const request = new Request('https://example.com', {
			headers: { Authorization: `Basic ${encoded}` },
		});

		const environment = { JWT_PUBLIC_KEY: publicKey } as unknown as GitWorkerEnvironment;
		const result = await authenticateGitRequest(environment, request, 'ide/project-123', 'git:write');

		expect(result.authenticated).toBe(false);
	});

	it('allows git:write scope to satisfy git:read requirement', async () => {
		const { publicKey, privateKey } = await generateKeyPair();
		const token = await signJwt(
			{
				iss: 'worker-ide',
				sub: 'ide/project-123',
				scopes: ['git:write'],
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			privateKey,
		);

		const encoded = btoa(`t:${token}`);
		const request = new Request('https://example.com', {
			headers: { Authorization: `Basic ${encoded}` },
		});

		const environment = { JWT_PUBLIC_KEY: publicKey } as unknown as GitWorkerEnvironment;
		const result = await authenticateGitRequest(environment, request, 'ide/project-123', 'git:read');

		expect(result.authenticated).toBe(true);
	});

	it('rejects when no Authorization header is present', async () => {
		const { publicKey } = await generateKeyPair();
		const request = new Request('https://example.com');

		const environment = { JWT_PUBLIC_KEY: publicKey } as unknown as GitWorkerEnvironment;
		const result = await authenticateGitRequest(environment, request, 'ide/project-123', 'git:read');

		expect(result.authenticated).toBe(false);
	});
});

// =============================================================================
// unauthorizedResponse
// =============================================================================

describe('unauthorizedResponse', () => {
	it('returns 401 status', () => {
		const response = unauthorizedResponse();
		expect(response.status).toBe(401);
	});

	it('includes WWW-Authenticate header', () => {
		const response = unauthorizedResponse();
		expect(response.headers.get('WWW-Authenticate')).toContain('Basic');
	});

	it('uses custom realm when provided', () => {
		const response = unauthorizedResponse('my-repo');
		expect(response.headers.get('WWW-Authenticate')).toContain('my-repo');
	});
});
