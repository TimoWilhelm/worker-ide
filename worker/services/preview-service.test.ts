import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('chobitsu?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/chobitsu-init.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/element-picker.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/error-overlay.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/hmr-client.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/preview-runtime.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/react-refresh-preamble.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));

import { buildPreviewExternalModuleRequest } from '@shared/preview-path';

import { PreviewService } from './preview-service';

function createResponseWithUrl(body: string, url: string, contentType = 'application/javascript'): Response {
	const response = new Response(body, { headers: { 'Content-Type': contentType } });
	Object.defineProperty(response, 'url', { value: url });
	return response;
}

describe('PreviewService external module proxy', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('rejects invalid external module requests before fetching', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const previewService = new PreviewService('/project', 'project-1');
		const response = await previewService.serveFile(
			new Request('https://preview.local/__preview_external?url=https%3A%2F%2Fexample.com%2Fmodule.mjs'),
			'https://ide.local',
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Invalid external module request');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects external module redirects that leave esm.sh', async () => {
		const fetchMock = vi.fn(async () => createResponseWithUrl('export default 1;', 'https://example.com/module.mjs'));
		vi.stubGlobal('fetch', fetchMock);

		const previewService = new PreviewService('/project', 'project-1');
		const response = await previewService.serveFile(
			new Request(`https://preview.local${buildPreviewExternalModuleRequest('react')}`),
			'https://ide.local',
		);

		expect(response.headers.get('Content-Type')).toBe('application/javascript');
		expect(await response.text()).toContain('External module redirect target is not allowed');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
