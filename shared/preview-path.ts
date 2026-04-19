export function toAbsolutePreviewPath(path: string): string {
	if (path.length === 0) {
		return '/';
	}

	return path.startsWith('/') ? path : `/${path}`;
}
