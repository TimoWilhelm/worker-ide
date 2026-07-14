import { and, eq, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { HttpErrorCode } from '@shared/http-errors';

import { decryptToken, encryptToken } from './cloudflare-oauth-crypto';
import { httpError } from './http-error';
import * as schema from '../db/auth-schema';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
// Keep in sync with Wrangler's temporary preview account proof-of-work limit.
const MAX_PROOF_OF_WORK_ITERATIONS = 64_000_000;

interface TemporaryAccountResponse {
	account: { id: string; name: string; apiToken: string; expiresAt: string };
	claim: { url: string; expiresAt: string };
}

interface TemporaryAccountEnvironment {
	DB: D1Database;
	BETTER_AUTH_SECRET: string;
}

export interface TemporaryAccount {
	accountId: string;
	accessToken: string;
	claimUrl: string;
	expiresAt: Date;
}

function decodeBase64Url(value: string): Uint8Array {
	const padded = value
		.replaceAll('-', '+')
		.replaceAll('_', '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
}

function encodeBase64(chunks: Uint8Array[]): string {
	let binary = '';
	for (const chunk of chunks) {
		for (const byte of chunk) binary += String.fromCodePoint(byte);
	}
	return btoa(binary);
}

async function solveProofOfWork(seed: string, checkpointCount: number, hashesPerCheckpoint: number): Promise<string> {
	if (!isSupportedProofOfWork(checkpointCount, hashesPerCheckpoint)) {
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Cloudflare returned an unsupported temporary account challenge');
	}

	const checkpoints: Uint8Array[] = [];
	let hash = new Uint8Array(await crypto.subtle.digest('SHA-256', decodeBase64Url(seed)));
	checkpoints.push(hash);
	for (let checkpoint = 0; checkpoint < checkpointCount; checkpoint += 1) {
		for (let iteration = 0; iteration < hashesPerCheckpoint; iteration += 1) {
			hash = new Uint8Array(await crypto.subtle.digest('SHA-256', hash));
		}
		checkpoints.push(hash);
	}
	return encodeBase64(checkpoints);
}

export function isSupportedProofOfWork(checkpointCount: number, hashesPerCheckpoint: number): boolean {
	return (
		Number.isInteger(checkpointCount) &&
		Number.isInteger(hashesPerCheckpoint) &&
		checkpointCount > 0 &&
		hashesPerCheckpoint > 0 &&
		checkpointCount * hashesPerCheckpoint <= MAX_PROOF_OF_WORK_ITERATIONS
	);
}

async function createTemporaryAccount(): Promise<TemporaryAccountResponse> {
	const challengeResponse = await fetch(`${CLOUDFLARE_API_BASE}/provisioning/previews/challenge`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{}',
	});
	if (!challengeResponse.ok) {
		console.error('[temp-account] challenge request failed', challengeResponse.status);
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Failed to request a temporary Cloudflare account');
	}

	const challengeBody: unknown = await challengeResponse.json();
	if (!isChallengeResponse(challengeBody)) {
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Cloudflare returned an invalid temporary account challenge');
	}

	const checkpoints = await solveProofOfWork(challengeBody.result.seed, challengeBody.result.k, challengeBody.result.g);
	const accountResponse = await fetch(`${CLOUDFLARE_API_BASE}/provisioning/previews`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			termsOfService: 'https://www.cloudflare.com/terms/',
			privacyPolicy: 'https://www.cloudflare.com/privacypolicy/',
			acceptTermsOfService: 'yes',
			challengeToken: challengeBody.result.challengeToken,
			solution: { checkpoints },
		}),
	});
	if (!accountResponse.ok) {
		console.error('[temp-account] account creation failed', accountResponse.status);
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Failed to create a temporary Cloudflare account');
	}

	const accountBody: unknown = await accountResponse.json();
	if (!isTemporaryAccountResponse(accountBody)) {
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Cloudflare returned an invalid temporary account');
	}
	return accountBody.result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isChallengeResponse(value: unknown): value is { result: { challengeToken: string; seed: string; k: number; g: number } } {
	if (!isRecord(value) || !isRecord(value.result)) return false;
	const { challengeToken, seed, k, g } = value.result;
	return typeof challengeToken === 'string' && typeof seed === 'string' && typeof k === 'number' && typeof g === 'number';
}

function isTemporaryAccountResponse(value: unknown): value is { result: TemporaryAccountResponse } {
	if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.result.account) || !isRecord(value.result.claim)) return false;
	const { account, claim } = value.result;
	return (
		typeof account.id === 'string' &&
		typeof account.name === 'string' &&
		typeof account.apiToken === 'string' &&
		typeof account.expiresAt === 'string' &&
		typeof claim.url === 'string' &&
		typeof claim.expiresAt === 'string'
	);
}

async function getStoredTemporaryAccount(
	environment: TemporaryAccountEnvironment,
	userId: string,
	projectId: string,
): Promise<TemporaryAccount | undefined> {
	const database = drizzle(environment.DB, { schema });
	const rows = await database
		.select()
		.from(schema.cloudflareTemporaryAccount)
		.where(
			and(
				eq(schema.cloudflareTemporaryAccount.userId, userId),
				eq(schema.cloudflareTemporaryAccount.projectId, projectId),
				gt(schema.cloudflareTemporaryAccount.expiresAt, new Date()),
			),
		)
		.limit(1);
	const account = rows[0];
	if (!account) return undefined;
	const accessToken = await decryptToken(environment.BETTER_AUTH_SECRET, account.accessTokenEncrypted);
	if (!accessToken) return undefined;
	return { accountId: account.accountId, accessToken, claimUrl: account.claimUrl, expiresAt: account.expiresAt };
}

export async function getOrCreateTemporaryAccount(
	environment: TemporaryAccountEnvironment,
	userId: string,
	projectId: string,
): Promise<TemporaryAccount> {
	const existing = await getStoredTemporaryAccount(environment, userId, projectId);
	if (existing) return existing;

	const account = await createTemporaryAccount();
	const expiresAt = new Date(account.account.expiresAt);
	if (Number.isNaN(expiresAt.getTime())) {
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Cloudflare returned an invalid temporary account expiry');
	}
	const now = new Date();
	const accessTokenEncrypted = await encryptToken(environment.BETTER_AUTH_SECRET, account.account.apiToken);
	const database = drizzle(environment.DB, { schema });
	await database
		.insert(schema.cloudflareTemporaryAccount)
		.values({
			userId,
			projectId,
			accountId: account.account.id,
			accessTokenEncrypted,
			claimUrl: account.claim.url,
			expiresAt,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [schema.cloudflareTemporaryAccount.userId, schema.cloudflareTemporaryAccount.projectId],
			set: { accountId: account.account.id, accessTokenEncrypted, claimUrl: account.claim.url, expiresAt, updatedAt: now },
		});
	return { accountId: account.account.id, accessToken: account.account.apiToken, claimUrl: account.claim.url, expiresAt };
}

export async function getTemporaryAccount(
	environment: TemporaryAccountEnvironment,
	userId: string,
	projectId: string,
	accountId: string,
): Promise<TemporaryAccount | undefined> {
	const account = await getStoredTemporaryAccount(environment, userId, projectId);
	return account?.accountId === accountId ? account : undefined;
}
