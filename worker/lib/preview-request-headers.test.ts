import { describe, expect, it } from 'vitest';

import { STRIPPED_PREVIEW_REQUEST_HEADERS, stripPreviewRequestCredentials } from './preview-request-headers';

describe('stripPreviewRequestCredentials', () => {
	it('removes the private-preview access cookie so app code cannot read it', () => {
		const headers = new Headers({
			Cookie: '__Host-worker-ide-preview-access=signed-grant-token; other=1',
			'Content-Type': 'text/html',
		});
		stripPreviewRequestCredentials(headers);
		expect(headers.get('Cookie')).toBeNull();
		expect(headers.get('Content-Type')).toBe('text/html');
	});

	it('removes every credential header, case-insensitively', () => {
		const headers = new Headers({
			authorization: 'Bearer secret',
			cookie: 'a=b',
			'Proxy-Authorization': 'Basic xyz',
			'X-Keep': 'yes',
		});
		stripPreviewRequestCredentials(headers);
		for (const name of STRIPPED_PREVIEW_REQUEST_HEADERS) {
			expect(headers.get(name)).toBeNull();
		}
		expect(headers.get('X-Keep')).toBe('yes');
	});
});
