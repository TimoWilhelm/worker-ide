/**
 * Cloudflare self-managed OAuth service.
 *
 * Implements the Authorization Code + PKCE flow that lets a user authorize the
 * IDE to deploy Workers into their own Cloudflare account. Tokens are stored
 * encrypted per-user in D1 (`cloudflare_connection`) and refreshed on demand.
 *
 * Replaces the legacy flow where users pasted a long-lived API token.
 */

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';

import {
	CLOUDFLARE_API_BASE,
	CLOUDFLARE_OAUTH_AUTHORIZE_URL,
	CLOUDFLARE_OAUTH_REFRESH_LEEWAY_SECONDS,
	CLOUDFLARE_OAUTH_REVOKE_URL,
	CLOUDFLARE_OAUTH_SCOPES,
	CLOUDFLARE_OAUTH_TOKEN_URL,
	CLOUDFLARE_OAUTH_USERINFO_URL,
} from '@shared/constants';

import { decryptToken, encryptToken } from './cloudflare-oauth-crypto';
import * as schema from '../db/auth-schema';

import type { CloudflareAccount } from '@shared/deploy-types';

export interface CloudflareOAuthEnvironment {
	DB: D1Database;
	BETTER_AUTH_SECRET: string;
	CLOUDFLARE_OAUTH_CLIENT_ID: string;
	CLOUDFLARE_OAUTH_CLIENT_SECRET: string;
}

const tokenResponseSchema = z.object({
	access_token: z.string(),
	token_type: z.string().optional(),
	expires_in: z.number().optional(),
	refresh_token: z.string().optional(),
	scope: z.string().optional(),
});

type TokenResponse = z.infer<typeof tokenResponseSchema>;

const userInfoSchema = z.object({
	sub: z.string().optional(),
	email: z.string().optional(),
});

const membershipsResponseSchema = z.object({
	result: z
		.array(
			z.object({
				status: z.string().optional(),
				account: z.object({ id: z.string(), name: z.string() }),
			}),
		)
		.optional(),
});

// ---------------------------------------------------------------------------
// PKCE + state helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCodePoint(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function generateCodeVerifier(): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function generateState(): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveCodeChallenge(codeVerifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
	return base64UrlEncode(new Uint8Array(digest));
}

export function buildAuthorizationUrl(options: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
	const url = new URL(CLOUDFLARE_OAUTH_AUTHORIZE_URL);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', options.clientId);
	url.searchParams.set('redirect_uri', options.redirectUri);
	url.searchParams.set('scope', CLOUDFLARE_OAUTH_SCOPES.join(' '));
	url.searchParams.set('state', options.state);
	url.searchParams.set('code_challenge', options.codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint calls
// ---------------------------------------------------------------------------

function basicAuthHeader(environment: CloudflareOAuthEnvironment): string {
	return `Basic ${btoa(`${environment.CLOUDFLARE_OAUTH_CLIENT_ID}:${environment.CLOUDFLARE_OAUTH_CLIENT_SECRET}`)}`;
}

async function requestToken(environment: CloudflareOAuthEnvironment, body: URLSearchParams): Promise<TokenResponse> {
	const response = await fetch(CLOUDFLARE_OAUTH_TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Authorization: basicAuthHeader(environment),
		},
		body: body.toString(),
	});

	if (!response.ok) {
		throw new Error(`Cloudflare token endpoint returned ${response.status}`);
	}

	const parsed = tokenResponseSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error('Cloudflare token endpoint returned an invalid response');
	}
	return parsed.data;
}

export async function exchangeCodeForTokens(
	environment: CloudflareOAuthEnvironment,
	options: { code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenResponse> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code: options.code,
		redirect_uri: options.redirectUri,
		code_verifier: options.codeVerifier,
	});
	return requestToken(environment, body);
}

async function refreshAccessToken(environment: CloudflareOAuthEnvironment, refreshToken: string): Promise<TokenResponse> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
	});
	return requestToken(environment, body);
}

export async function revokeToken(environment: CloudflareOAuthEnvironment, token: string): Promise<void> {
	try {
		await fetch(CLOUDFLARE_OAUTH_REVOKE_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Authorization: basicAuthHeader(environment),
			},
			body: new URLSearchParams({ token }).toString(),
		});
	} catch (error) {
		// Revocation is best-effort; the local connection is deleted regardless.
		console.error('Failed to revoke Cloudflare token:', error);
	}
}

// ---------------------------------------------------------------------------
// Cloudflare API calls (user identity + accounts)
// ---------------------------------------------------------------------------

export async function fetchCloudflareEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch(CLOUDFLARE_OAUTH_USERINFO_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!response.ok) return undefined;
		const parsed = userInfoSchema.safeParse(await response.json());
		return parsed.success ? parsed.data.email : undefined;
	} catch {
		return undefined;
	}
}

export async function listAccounts(accessToken: string): Promise<CloudflareAccount[]> {
	const response = await fetch(`${CLOUDFLARE_API_BASE}/memberships?per_page=50`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!response.ok) {
		throw new Error(`Failed to list Cloudflare accounts (status ${response.status})`);
	}
	const parsed = membershipsResponseSchema.safeParse(await response.json());
	if (!parsed.success || !parsed.data.result) {
		return [];
	}
	return parsed.data.result
		.filter((membership) => membership.status === undefined || membership.status === 'accepted')
		.map((membership) => ({ id: membership.account.id, name: membership.account.name }));
}

// ---------------------------------------------------------------------------
// Connection persistence
// ---------------------------------------------------------------------------

function expiresAtFromResponse(tokenResponse: TokenResponse): Date | undefined {
	if (typeof tokenResponse.expires_in !== 'number') return undefined;
	return new Date(Date.now() + tokenResponse.expires_in * 1000);
}

export async function storeConnection(
	environment: CloudflareOAuthEnvironment,
	userId: string,
	tokenResponse: TokenResponse,
	options: { email?: string; previousRefreshTokenEncrypted?: string } = {},
): Promise<void> {
	const database = drizzle(environment.DB, { schema });
	const now = new Date();
	const accessTokenEncrypted = await encryptToken(environment.BETTER_AUTH_SECRET, tokenResponse.access_token);
	const refreshTokenEncrypted = tokenResponse.refresh_token
		? await encryptToken(environment.BETTER_AUTH_SECRET, tokenResponse.refresh_token)
		: options.previousRefreshTokenEncrypted;

	await database
		.insert(schema.cloudflareConnection)
		.values({
			userId,
			accessTokenEncrypted,
			refreshTokenEncrypted,
			accessTokenExpiresAt: expiresAtFromResponse(tokenResponse),
			scope: tokenResponse.scope,
			cloudflareEmail: options.email,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: schema.cloudflareConnection.userId,
			set: {
				accessTokenEncrypted,
				refreshTokenEncrypted,
				accessTokenExpiresAt: expiresAtFromResponse(tokenResponse),
				scope: tokenResponse.scope,
				// Only overwrite the stored email when we have a fresh one.
				...(options.email ? { cloudflareEmail: options.email } : {}),
				updatedAt: now,
			},
		});
}

export async function getConnection(
	environment: Pick<CloudflareOAuthEnvironment, 'DB'>,
	userId: string,
): Promise<schema.CloudflareConnectionRow | undefined> {
	const database = drizzle(environment.DB, { schema });
	const rows = await database.select().from(schema.cloudflareConnection).where(eq(schema.cloudflareConnection.userId, userId)).limit(1);
	return rows[0];
}

export async function deleteConnection(environment: Pick<CloudflareOAuthEnvironment, 'DB'>, userId: string): Promise<void> {
	const database = drizzle(environment.DB, { schema });
	await database.delete(schema.cloudflareConnection).where(eq(schema.cloudflareConnection.userId, userId));
}

/**
 * Return a valid Cloudflare access token for the user, refreshing it if it is
 * expired (or about to expire). Returns `undefined` when the user has no
 * connection or the refresh token is no longer valid — callers should treat
 * that as "needs to (re)connect".
 */
export async function getValidAccessToken(environment: CloudflareOAuthEnvironment, userId: string): Promise<string | undefined> {
	const connection = await getConnection(environment, userId);
	if (!connection) return undefined;

	const expiresAtMs = connection.accessTokenExpiresAt?.getTime();
	const stillValid = expiresAtMs !== undefined && expiresAtMs - CLOUDFLARE_OAUTH_REFRESH_LEEWAY_SECONDS * 1000 > Date.now();

	if (stillValid) {
		const accessToken = await decryptToken(environment.BETTER_AUTH_SECRET, connection.accessTokenEncrypted);
		if (accessToken) return accessToken;
	}

	if (!connection.refreshTokenEncrypted) {
		// No refresh token: fall back to the stored access token if we can't tell
		// whether it has expired (no expiry recorded).
		if (expiresAtMs === undefined) {
			return decryptToken(environment.BETTER_AUTH_SECRET, connection.accessTokenEncrypted);
		}
		return undefined;
	}

	const refreshToken = await decryptToken(environment.BETTER_AUTH_SECRET, connection.refreshTokenEncrypted);
	if (!refreshToken) return undefined;

	try {
		const tokenResponse = await refreshAccessToken(environment, refreshToken);
		await storeConnection(environment, userId, tokenResponse, {
			previousRefreshTokenEncrypted: connection.refreshTokenEncrypted,
		});
		return tokenResponse.access_token;
	} catch (error) {
		console.error('Failed to refresh Cloudflare access token:', error);
		// The refresh token is likely revoked/expired; drop the dead connection.
		await deleteConnection(environment, userId);
		return undefined;
	}
}
