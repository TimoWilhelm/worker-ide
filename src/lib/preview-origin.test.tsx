import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePreviewUrl } from './preview-origin';

const { authClientGetSession, previewUrlGet } = vi.hoisted(() => ({
	authClientGetSession: vi.fn(),
	previewUrlGet: vi.fn(),
}));

vi.mock('@/features/preview/preview-iframe-reference', () => ({
	previewIframeReference: { current: undefined },
	previewOriginReference: { current: undefined },
}));

vi.mock('@/lib/api-client', () => ({
	createApiClient: () => ({
		'preview-url': {
			$get: previewUrlGet,
		},
	}),
}));

vi.mock('@/lib/auth-client', () => ({
	authClient: {
		getSession: authClientGetSession,
	},
}));

describe('usePreviewUrl', () => {
	beforeEach(() => {
		previewUrlGet.mockReset();
		authClientGetSession.mockReset();
	});

	it('refreshes the auth session and retries after an unauthorized preview-url response', async () => {
		previewUrlGet.mockResolvedValueOnce({ ok: false, status: 401 }).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				url: 'https://example.com/',
				origin: 'https://example.com',
			}),
		});
		authClientGetSession.mockResolvedValue({
			data: { session: { id: 'session-1' } },
			error: undefined,
		});

		const { result } = renderHook(() => usePreviewUrl('project-1'));

		await waitFor(() => {
			expect(result.current.previewUrl).toBe('https://example.com/');
		});

		expect(authClientGetSession).toHaveBeenCalledOnce();
		expect(previewUrlGet).toHaveBeenCalledTimes(2);
		expect(result.current.previewOrigin).toBe('https://example.com');
		expect(result.current.isLoading).toBe(false);
	});
});
