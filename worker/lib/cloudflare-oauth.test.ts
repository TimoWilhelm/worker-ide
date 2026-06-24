import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	buildAuthorizationUrl,
	deriveCodeChallenge,
	exchangeCodeForTokens,
	generateCodeVerifier,
	generateState,
	listAccounts,
} from './cloudflare-oauth';

import type { CloudflareOAuthEnvironment } from './cloudflare-oauth';

const oauthEnvironment: CloudflareOAuthEnvironment = {
	// DB is unused by the functions under test here.
	DB: undefined as unknown as D1Database,
	BETTER_AUTH_SECRET: 'secret',
	CLOUDFLARE_OAUTH_CLIENT_ID: 'client-id',
	CLOUDFLARE_OAUTH_CLIENT_SECRET: 'client-secret',
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('PKCE helpers', () => {
	it('generates URL-safe code verifiers', () => {
		const verifier = generateCodeVerifier();
		expect(verifier).toMatch(/^[\w-]+$/);
		expect(verifier.length).toBeGreaterThanOrEqual(43);
	});

	it('derives a deterministic S256 challenge', async () => {
		const verifier = 'fixed-verifier-value';
		const a = await deriveCodeChallenge(verifier);
		const b = await deriveCodeChallenge(verifier);
		expect(a).toBe(b);
		expect(a).toMatch(/^[\w-]+$/);
		expect(a).not.toContain('=');
	});

	it('generates unique states', () => {
		expect(generateState()).not.toBe(generateState());
	});
});

describe('buildAuthorizationUrl', () => {
	it('includes all required OAuth parameters', () => {
		const url = new URL(
			buildAuthorizationUrl({
				clientId: 'client-id',
				redirectUri: 'https://ide.example.com/api/cloudflare/oauth/callback',
				state: 'state-value',
				codeChallenge: 'challenge-value',
			}),
		);

		expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('client_id')).toBe('client-id');
		expect(url.searchParams.get('redirect_uri')).toBe('https://ide.example.com/api/cloudflare/oauth/callback');
		expect(url.searchParams.get('state')).toBe('state-value');
		expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('scope')).toContain('workers-scripts.write');
		expect(url.searchParams.get('scope')).toContain('offline_access');
	});
});

describe('exchangeCodeForTokens', () => {
	it('posts the authorization code and parses the token response', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json(
				{ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 },
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const result = await exchangeCodeForTokens(oauthEnvironment, {
			code: 'the-code',
			codeVerifier: 'the-verifier',
			redirectUri: 'https://ide.example.com/api/cloudflare/oauth/callback',
		});

		expect(result.access_token).toBe('access');
		expect(result.refresh_token).toBe('refresh');

		const [, options] = fetchMock.mock.calls[0];
		expect(options?.method).toBe('POST');
		const body = String(options?.body);
		expect(body).toContain('grant_type=authorization_code');
		expect(body).toContain('code=the-code');
		expect(body).toContain('code_verifier=the-verifier');
		const headers = new Headers(options?.headers);
		expect(headers.get('Authorization')).toBe(`Basic ${btoa('client-id:client-secret')}`);
	});

	it('throws when the token endpoint fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 400 }));
		await expect(exchangeCodeForTokens(oauthEnvironment, { code: 'c', codeVerifier: 'v', redirectUri: 'https://x/cb' })).rejects.toThrow();
	});
});

describe('listAccounts', () => {
	it('maps accepted memberships to accounts', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json(
				{
					result: [
						{ status: 'accepted', account: { id: 'acc-1', name: 'Account One' } },
						{ status: 'pending', account: { id: 'acc-2', name: 'Account Two' } },
					],
				},
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);

		const accounts = await listAccounts('access-token');
		expect(accounts).toEqual([{ id: 'acc-1', name: 'Account One' }]);
	});

	it('throws when the memberships request fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('error', { status: 403 }));
		await expect(listAccounts('access-token')).rejects.toThrow();
	});
});
