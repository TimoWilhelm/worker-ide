/**
 * Content type utilities for serving files.
 */

import { CONTENT_TYPE_MAP } from '@shared/constants';

/**
 * Get the content type for a file based on its extension.
 */
export function getContentType(path: string): string {
	const extension = path.split('.').pop()?.toLowerCase();
	return CONTENT_TYPE_MAP[extension ?? ''] ?? 'application/octet-stream';
}
