/**
 * Frontend origin utilities for subdomain URLs and cross-origin message validation.
 *
 * Preview URLs are HMAC-signed with time-bucket tokens. The frontend
 * fetches a signed URL from the API on IDE load and caches it for the
 * session. The `usePreviewUrl` hook manages the lifecycle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getBaseDomain, isPreviewOrigin } from '@shared/domain';

import { createApiClient } from './api-client';

/** Get the URL path for a project (same-origin navigation). */
export function getProjectUrl(projectId: string): string {
	return `/p/${projectId}`;
}

/** Check if a message event came from a preview subdomain. */
export function isMessageFromPreview(event: MessageEvent): boolean {
	return isPreviewOrigin(event.origin, getBaseDomain(globalThis.location.host));
}

// =============================================================================
// Preview URL Hook
// =============================================================================

interface PreviewUrlState {
	/** Full signed preview URL with trailing slash (e.g., `https://abc-d1e2f3a4b5c6.preview.example.com/`). */
	previewUrl: string | undefined;
	/** Preview origin without trailing path (e.g., `https://abc-d1e2f3a4b5c6.preview.example.com`). */
	previewOrigin: string | undefined;
	/** Whether the initial fetch is in progress. */
	isLoading: boolean;
	/** Fetch a fresh signed URL (e.g., after a 403 from the preview iframe). */
	refresh: () => Promise<void>;
}

/**
 * Fetch and manage a signed preview URL for a project.
 *
 * The hook fetches a signed URL from `GET /api/preview-url` on mount
 * and exposes a `refresh()` function for the preview panel to call
 * when it detects a 403 (expired token).
 */
export function usePreviewUrl(projectId: string): PreviewUrlState {
	const [previewUrl, setPreviewUrl] = useState<string | undefined>();
	const [previewOrigin, setPreviewOrigin] = useState<string | undefined>();
	const [isLoading, setIsLoading] = useState(true);
	const fetchingReference = useRef(false);

	const fetchPreviewUrl = useCallback(async () => {
		if (fetchingReference.current) return;
		fetchingReference.current = true;
		try {
			const api = createApiClient(projectId);
			const response = await api['preview-url'].$get({});
			if (!response.ok) {
				console.error('Failed to fetch preview URL');
				return;
			}
			const data = await response.json();
			setPreviewUrl(data.url);
			setPreviewOrigin(data.origin);
		} catch (error) {
			console.error('Failed to fetch preview URL:', error);
		} finally {
			setIsLoading(false);
			fetchingReference.current = false;
		}
	}, [projectId]);

	useEffect(() => {
		setIsLoading(true);
		setPreviewUrl(undefined);
		setPreviewOrigin(undefined);
		void fetchPreviewUrl();
	}, [fetchPreviewUrl]);

	const refresh = useCallback(async () => {
		await fetchPreviewUrl();
	}, [fetchPreviewUrl]);

	return { previewUrl, previewOrigin, isLoading, refresh };
}
