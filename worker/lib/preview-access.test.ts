import { describe, expect, it } from 'vitest';

import {
	buildPreviewAccessBootstrapUrl,
	buildPreviewAccessLoginUrl,
	buildPreviewRedeemUrl,
	createPreviewAccessCookieToken,
	createPreviewAccessGrant,
	clearPreviewAccessCookie,
	getRedirectPath,
	isNavigationRequest,
	readPreviewAccessCookie,
	readPreviewAccessGrant,
	serializePreviewAccessCookie,
} from './preview-access';

const secret = 'preview-secret';

describe('preview access helpers', () => {
	it('round-trips a preview access grant', async () => {
		const grant = await createPreviewAccessGrant(
			{
				projectId: 'project123',
				previewToken: 'abcdef123456',
				organizationId: 'org-1',
				userId: 'user-1',
				redirectPath: '/nested/path?query=1',
			},
			secret,
		);

		const payload = await readPreviewAccessGrant(grant, secret);
		expect(payload).toMatchObject({
			projectId: 'project123',
			previewToken: 'abcdef123456',
			organizationId: 'org-1',
			userId: 'user-1',
			redirectPath: '/nested/path?query=1',
		});
		expect(payload?.expiresAt).toBeGreaterThan(Date.now());
	});

	it('only accepts preview cookies for the expected project and token', async () => {
		const cookieToken = await createPreviewAccessCookieToken(
			{
				projectId: 'project123',
				previewToken: 'abcdef123456',
				organizationId: 'org-1',
				userId: 'user-1',
			},
			secret,
		);
		const securePreviewUrl = new URL('https://project123-abcdef123456.preview.example.app/');
		const headers = new Headers({ Cookie: `__Host-worker-ide-preview-access=${encodeURIComponent(cookieToken)}` });

		await expect(readPreviewAccessCookie(headers, secret, 'project123', 'abcdef123456', securePreviewUrl)).resolves.toMatchObject({
			projectId: 'project123',
			previewToken: 'abcdef123456',
			organizationId: 'org-1',
			userId: 'user-1',
		});
		await expect(readPreviewAccessCookie(headers, secret, 'project123', 'differenttoken', securePreviewUrl)).resolves.toBeUndefined();
	});

	it('uses a non-secure host-only cookie for local http previews', async () => {
		const localPreviewUrl = new URL('http://project123-abcdef123456.preview.localhost:3000/');
		const serializedCookies = serializePreviewAccessCookie('cookie-token', localPreviewUrl);
		expect(serializedCookies[0]).toContain('worker-ide-preview-access=cookie-token');
		expect(serializedCookies[0]).not.toContain('__Host-');
		expect(serializedCookies[0]).not.toContain('Secure');
		expect(serializedCookies[0]).toContain('SameSite=Lax');
		expect(serializedCookies[1]).toContain('worker-ide-preview-access-partitioned=cookie-token');
		expect(serializedCookies[1]).toContain('Secure');
		expect(serializedCookies[1]).toContain('SameSite=None');
		expect(serializedCookies[1]).toContain('Partitioned');

		const clearedCookies = clearPreviewAccessCookie(localPreviewUrl);
		expect(clearedCookies[0]).toContain('worker-ide-preview-access=');
		expect(clearedCookies[0]).toContain('Max-Age=0');
		expect(clearedCookies[1]).toContain('worker-ide-preview-access-partitioned=');
		expect(clearedCookies[1]).toContain('Partitioned');
	});

	it('keeps the secure __Host- cookie on https previews', () => {
		const securePreviewUrl = new URL('https://project123-abcdef123456.preview.example.app/');
		const serializedCookies = serializePreviewAccessCookie('cookie-token', securePreviewUrl);
		expect(serializedCookies).toHaveLength(1);
		expect(serializedCookies[0]).toContain('__Host-worker-ide-preview-access=cookie-token');
		expect(serializedCookies[0]).toContain('Secure');
		expect(serializedCookies[0]).toContain('SameSite=Strict');
	});

	it('builds bootstrap, login, and redeem URLs', () => {
		expect(buildPreviewAccessBootstrapUrl('https://example.app', 'project123', 'https://project123.preview.example.app/')).toBe(
			'https://example.app/p/project123/__preview-auth/bootstrap?returnTo=https%3A%2F%2Fproject123.preview.example.app%2F',
		);
		expect(buildPreviewAccessLoginUrl('https://example.app', 'https://example.app/p/project123/__preview-auth/bootstrap')).toBe(
			'https://example.app/?next=https%3A%2F%2Fexample.app%2Fp%2Fproject123%2F__preview-auth%2Fbootstrap',
		);
		expect(buildPreviewRedeemUrl('https://project123.preview.example.app', 'grant-token')).toBe(
			'https://project123.preview.example.app/__preview_auth?grant=grant-token',
		);
	});

	it('detects navigation requests and safe redirect paths', () => {
		expect(isNavigationRequest(new Request('https://preview.example.app/', { headers: { 'Sec-Fetch-Mode': 'navigate' } }))).toBe(true);
		expect(isNavigationRequest(new Request('https://preview.example.app/data.json'))).toBe(false);
		expect(getRedirectPath(new URL('https://preview.example.app/path?query=1'))).toBe('/path?query=1');
		expect(getRedirectPath(new URL('https://preview.example.app/__preview_auth?grant=test'))).toBe('/');
	});
});
