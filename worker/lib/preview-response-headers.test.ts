import { describe, expect, it } from 'vitest';

import { applyPreviewResponseMiddlewares, previewResponseMiddlewares } from './preview-response-headers';

const finalize = (response: Response, ideOrigin = 'https://ide.example.com'): Response =>
	applyPreviewResponseMiddlewares(response, { ideOrigin }, previewResponseMiddlewares);

describe('applyPreviewResponseMiddlewares', () => {
	it('tags every preview response as noindex for search engines', () => {
		const html = finalize(new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
		const asset = finalize(new Response('body{}', { headers: { 'Content-Type': 'text/css' } }));
		expect(html.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		expect(asset.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
	});

	it('applies asset security headers to non-HTML responses', () => {
		const asset = finalize(new Response('console.log(1)', { headers: { 'Content-Type': 'application/javascript' } }));
		expect(asset.headers.get('Cross-Origin-Resource-Policy')).toBe('same-site');
		expect(asset.headers.get('Content-Security-Policy')).toBe('frame-ancestors https://ide.example.com');
		expect(asset.headers.get('Referrer-Policy')).toBe('no-referrer');
	});

	it('does not constrain HTML responses with asset security headers (keeps them iframe-navigable)', () => {
		const html = finalize(new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
		expect(html.headers.get('Cross-Origin-Resource-Policy')).toBeNull();
		expect(html.headers.get('Content-Security-Policy')).toBeNull();
	});

	it('preserves the original status and body', async () => {
		const finalized = finalize(new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }));
		expect(finalized.status).toBe(404);
		expect(await finalized.text()).toBe('not found');
	});
});
