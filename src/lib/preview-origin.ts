import { useCallback, useEffect, useRef, useState } from 'react';

import { previewIframeReference, previewOriginReference } from '@/features/preview/preview-iframe-reference';
import { authClient } from '@/lib/auth-client';

import { createApiClient } from './api-client';
export function getProjectUrl(projectId: string): string {
	return `/p/${projectId}`;
}
export function isMessageFromPreview(event: MessageEvent): boolean {
	const previewWindow = previewIframeReference.current?.contentWindow;
	const previewOrigin = previewOriginReference.current;
	if (!previewWindow || !previewOrigin) {
		return false;
	}

	return event.source === previewWindow && event.origin === previewOrigin;
}

interface PreviewUrlState {
	previewUrl: string | undefined;
	previewOrigin: string | undefined;
	isLoading: boolean;
	refresh: () => Promise<string | undefined>;
}

/**
 * Fetch and manage a signed preview URL for a project.
 *
 * The hook fetches a preview URL from `GET /api/preview-url` on mount.
 * For private previews this is a short-lived preview-host redeem URL that sets
 * a preview-only cookie before redirecting to the actual preview origin. Direct
 * shared preview links still use the preview-host bootstrap fallback.
 */
export function usePreviewUrl(projectId: string): PreviewUrlState {
	const [previewUrl, setPreviewUrl] = useState<string | undefined>();
	const [previewOrigin, setPreviewOrigin] = useState<string | undefined>();
	const [isLoading, setIsLoading] = useState(true);
	const fetchingReference = useRef(false);
	const refreshRequestedReference = useRef(false);
	const previewUrlReference = useRef<string | undefined>(undefined);

	const fetchPreviewUrl = useCallback(async (): Promise<string | undefined> => {
		if (fetchingReference.current) {
			// A fetch is already in progress — flag that a refresh was requested
			// so we re-fetch once the current request completes.
			refreshRequestedReference.current = true;
			return previewUrlReference.current;
		}

		setIsLoading(true);
		fetchingReference.current = true;
		refreshRequestedReference.current = false;
		try {
			const api = createApiClient(projectId);
			let response = await api['preview-url'].$get({});
			if (response.status === 401) {
				const session = await authClient.getSession();
				if (session.data) {
					response = await api['preview-url'].$get({});
				}
			}
			if (!response.ok) {
				console.error('Failed to fetch preview URL');
				return previewUrlReference.current;
			}
			const data = await response.json();
			previewUrlReference.current = data.url;
			setPreviewUrl(data.url);
			setPreviewOrigin(data.origin);
			return data.url;
		} catch (error) {
			console.error('Failed to fetch preview URL:', error);
			return previewUrlReference.current;
		} finally {
			setIsLoading(false);
			fetchingReference.current = false;

			// If a refresh was requested while we were fetching, re-fetch now.
			if (refreshRequestedReference.current) {
				refreshRequestedReference.current = false;
				void fetchPreviewUrl();
			}
		}
	}, [projectId]);

	useEffect(() => {
		setIsLoading(true);
		setPreviewUrl(undefined);
		setPreviewOrigin(undefined);
		previewUrlReference.current = undefined;
		void fetchPreviewUrl();
	}, [fetchPreviewUrl]);

	const refresh = useCallback(async () => {
		return fetchPreviewUrl();
	}, [fetchPreviewUrl]);

	return { previewUrl, previewOrigin, isLoading, refresh };
}
