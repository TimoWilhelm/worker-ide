/**
 * Frontend origin utilities for subdomain URLs and cross-origin message validation.
 */

import { buildPreviewOrigin, getBaseDomain, isPreviewOrigin } from '@shared/domain';

/** Get the URL path for a project (same-origin navigation). */
export function getProjectUrl(projectId: string): string {
	return `/p/${projectId}`;
}

/** Get the preview origin for a project (e.g., `http://<encoded>.preview.localhost:3000`). */
export function getPreviewOrigin(projectId: string): string {
	const { protocol, host } = globalThis.location;
	return buildPreviewOrigin(projectId, getBaseDomain(host), protocol);
}

/** Get the preview URL with trailing slash. */
export function getPreviewUrl(projectId: string): string {
	return `${getPreviewOrigin(projectId)}/`;
}

/** Check if a message event came from a preview subdomain. */
export function isMessageFromPreview(event: MessageEvent): boolean {
	return isPreviewOrigin(event.origin, getBaseDomain(globalThis.location.host));
}
