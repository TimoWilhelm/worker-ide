import { CONTENT_TYPE_MAP } from '@shared/constants';
export function getContentType(path: string): string {
	const extension = path.split('.').pop()?.toLowerCase();
	return CONTENT_TYPE_MAP[extension ?? ''] ?? 'application/octet-stream';
}
