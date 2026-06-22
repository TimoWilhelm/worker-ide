import { describe, expect, it } from 'vitest';

import { signGitToken, verifyGitToken } from './git-token';

const SECRET = 'test-secret-value';

describe('git-token', () => {
	it('signs and verifies a token round-trip', async () => {
		const { token, expiresAt } = await signGitToken(SECRET, { projectId: 'abc123', scope: 'read' });
		expect(typeof token).toBe('string');
		expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

		const claims = await verifyGitToken(SECRET, token);
		expect(claims).toEqual({ projectId: 'abc123', scope: 'read', exp: expect.any(Number) });
	});

	it('preserves the write scope', async () => {
		const { token } = await signGitToken(SECRET, { projectId: 'p1', scope: 'write' });
		const claims = await verifyGitToken(SECRET, token);
		expect(claims?.scope).toBe('write');
	});

	it('rejects a token signed with a different secret', async () => {
		const { token } = await signGitToken(SECRET, { projectId: 'p1', scope: 'read' });
		expect(await verifyGitToken('other-secret', token)).toBeUndefined();
	});

	it('rejects a tampered payload', async () => {
		const { token } = await signGitToken(SECRET, { projectId: 'p1', scope: 'read' });
		const [, signature] = token.split('.');
		const forgedPayload = btoa(JSON.stringify({ projectId: 'p1', scope: 'write', exp: Math.floor(Date.now() / 1000) + 60 }))
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replaceAll('=', '');
		expect(await verifyGitToken(SECRET, `${forgedPayload}.${signature}`)).toBeUndefined();
	});

	it('rejects an expired token', async () => {
		const { token } = await signGitToken(SECRET, { projectId: 'p1', scope: 'read', ttlSeconds: -10 });
		expect(await verifyGitToken(SECRET, token)).toBeUndefined();
	});

	it('rejects malformed tokens', async () => {
		expect(await verifyGitToken(SECRET, 'not-a-token')).toBeUndefined();
		expect(await verifyGitToken(SECRET, 'a.b.c')).toBeUndefined();
	});
});
