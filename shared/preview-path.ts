export type PreviewRequestMode = 'source' | 'module' | 'url';
export type PreviewUpdateTargetKind = 'module' | 'style-link';

export interface PreviewUpdateTarget {
	id: string;
	kind: PreviewUpdateTargetKind;
}

export interface PreviewRequest {
	path: string;
	mode: PreviewRequestMode;
	timestamp: string | undefined;
}

export interface PreviewExternalModuleRequest {
	externalUrl: string;
	timestamp: string | undefined;
}

const MODE_SEARCH_PARAM = 'mode';
const TIMESTAMP_SEARCH_PARAM = 't';
const EXTERNAL_URL_SEARCH_PARAM = 'url';

export const PREVIEW_EXTERNAL_MODULE_PATH = '/__preview_external';
const DEFAULT_EXTERNAL_MODULE_ORIGIN = 'https://esm.sh/';
const REACT_DEV_EXTERNAL_SPECIFIERS = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime', 'react/jsx-runtime']);

export function isAllowedPreviewExternalModuleUrl(url: URL): boolean {
	return (
		url.protocol === 'https:' &&
		url.hostname === 'esm.sh' &&
		url.port.length === 0 &&
		url.username.length === 0 &&
		url.password.length === 0
	);
}

const STYLE_EXTENSIONS = new Set(['.css']);
const MODULE_WRAPPED_EXTENSIONS = new Set(['.json']);
const URL_MODULE_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts']);

export function getPreviewPathExtension(path: string): string {
	const match = path.match(/\.[^.]+$/);
	return match ? match[0].toLowerCase() : '';
}

export function normalizePreviewPath(path: string): string {
	if (path.length === 0) {
		return '/';
	}

	let pathname = path;
	if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(pathname)) {
		try {
			pathname = new URL(pathname).pathname;
		} catch {
			pathname = path;
		}
	}

	pathname = pathname.split('#')[0] ?? pathname;
	pathname = pathname.split('?')[0] ?? pathname;
	pathname = pathname.replaceAll(/\/+/g, '/');

	if (pathname.length === 0) {
		return '/';
	}

	return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

export function toAbsolutePreviewPath(path: string): string {
	return normalizePreviewPath(path);
}

function toRequestSearch(mode: PreviewRequestMode, timestamp: string | undefined): string {
	const searchParameters = new URLSearchParams();
	if (mode !== 'source') {
		searchParameters.set(MODE_SEARCH_PARAM, mode);
	}
	if (timestamp !== undefined && timestamp.length > 0) {
		searchParameters.set(TIMESTAMP_SEARCH_PARAM, timestamp);
	}
	const search = searchParameters.toString();
	return search.length > 0 ? `?${search}` : '';
}

export function buildPreviewRequest(
	path: string,
	options?: { mode?: PreviewRequestMode; timestamp?: string | number | undefined },
): string {
	const normalizedPath = normalizePreviewPath(path);
	const mode = options?.mode ?? 'source';
	const timestamp = options?.timestamp === undefined ? undefined : String(options.timestamp);
	return normalizedPath + toRequestSearch(mode, timestamp);
}

export function parsePreviewRequest(pathOrUrl: string): PreviewRequest {
	const url = new URL(pathOrUrl, 'https://preview.local');
	const rawMode = url.searchParams.get(MODE_SEARCH_PARAM);
	const mode: PreviewRequestMode = rawMode === 'module' || rawMode === 'url' ? rawMode : 'source';
	const timestamp = url.searchParams.get(TIMESTAMP_SEARCH_PARAM) ?? undefined;

	return {
		path: normalizePreviewPath(url.pathname),
		mode,
		timestamp,
	};
}

function resolveExternalModuleUrl(specifierOrUrl: string, baseUrl?: string): URL {
	const shouldResolveFromOriginRoot =
		baseUrl !== undefined &&
		!specifierOrUrl.startsWith('.') &&
		!specifierOrUrl.startsWith('/') &&
		!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifierOrUrl);
	const resolutionBaseUrl = shouldResolveFromOriginRoot ? DEFAULT_EXTERNAL_MODULE_ORIGIN : (baseUrl ?? DEFAULT_EXTERNAL_MODULE_ORIGIN);
	const resolvedUrl = new URL(specifierOrUrl, resolutionBaseUrl);
	applyDevelopmentFlagToReactExternalModule(resolvedUrl);
	return resolvedUrl;
}

function appendSearchFlag(url: URL, flag: string): void {
	if (url.searchParams.has(flag)) {
		return;
	}

	url.search = url.search.length > 1 ? `${url.search}&${flag}` : `?${flag}`;
}

function getEsmShPackageSpecifier(pathname: string): string | undefined {
	const normalizedPath = pathname.replace(/^\/+/, '');
	if (normalizedPath.length === 0) {
		return undefined;
	}

	const [packageSegment, ...subpathSegments] = normalizedPath.split('/');
	const packageName = packageSegment?.replace(/@[^/]+$/, '');
	if (packageName !== 'react' && packageName !== 'react-dom') {
		return undefined;
	}

	const subpath = subpathSegments.join('/');
	return subpath.length > 0 ? `${packageName}/${subpath}` : packageName;
}

function applyDevelopmentFlagToReactExternalModule(url: URL): void {
	if (!isAllowedPreviewExternalModuleUrl(url)) {
		return;
	}

	const specifier = getEsmShPackageSpecifier(url.pathname);
	if (!specifier || !REACT_DEV_EXTERNAL_SPECIFIERS.has(specifier)) {
		return;
	}

	appendSearchFlag(url, 'dev');
}

export function buildPreviewExternalModuleRequest(
	specifierOrUrl: string,
	options?: { baseUrl?: string; timestamp?: string | number | undefined },
): string {
	const resolvedUrl = resolveExternalModuleUrl(specifierOrUrl, options?.baseUrl);
	if (!isAllowedPreviewExternalModuleUrl(resolvedUrl)) {
		throw new Error(`Unsupported external module URL: ${resolvedUrl.href}`);
	}
	const searchParameters = new URLSearchParams();
	searchParameters.set(EXTERNAL_URL_SEARCH_PARAM, resolvedUrl.href);
	if (options?.timestamp !== undefined) {
		searchParameters.set(TIMESTAMP_SEARCH_PARAM, String(options.timestamp));
	}
	return `${PREVIEW_EXTERNAL_MODULE_PATH}?${searchParameters.toString()}`;
}

export function parsePreviewExternalModuleRequest(pathOrUrl: string): PreviewExternalModuleRequest | undefined {
	const url = new URL(pathOrUrl, 'https://preview.local');
	if (normalizePreviewPath(url.pathname) !== PREVIEW_EXTERNAL_MODULE_PATH) {
		return undefined;
	}

	const externalUrl = url.searchParams.get(EXTERNAL_URL_SEARCH_PARAM);
	if (!externalUrl) {
		return undefined;
	}

	try {
		const parsedExternalUrl = new URL(externalUrl);
		if (!isAllowedPreviewExternalModuleUrl(parsedExternalUrl)) {
			return undefined;
		}

		return {
			externalUrl: parsedExternalUrl.href,
			timestamp: url.searchParams.get(TIMESTAMP_SEARCH_PARAM) ?? undefined,
		};
	} catch {
		return undefined;
	}
}

export function toPreviewExternalModuleId(specifierOrUrl: string, baseUrl?: string): string {
	return buildPreviewExternalModuleRequest(specifierOrUrl, { baseUrl });
}

export function withPreviewTimestamp(requestId: string, timestamp: string | number): string {
	const parsed = parsePreviewRequest(requestId);
	return buildPreviewRequest(parsed.path, {
		mode: parsed.mode,
		timestamp,
	});
}

export function resolvePreviewPath(specifier: string, importerPath: string): string {
	if (specifier.startsWith('/')) {
		return normalizePreviewPath(specifier);
	}

	const importerDirectory = importerPath.slice(0, Math.max(0, importerPath.lastIndexOf('/'))) || '/';
	const parts = importerDirectory.split('/').filter(Boolean);

	for (const part of specifier.split('/')) {
		if (part === '..') {
			parts.pop();
			continue;
		}
		if (part === '.' || part.length === 0) {
			continue;
		}
		parts.push(part);
	}

	return `/${parts.join('/')}`;
}

export function isPreviewJavaScriptPath(path: string): boolean {
	return JS_EXTENSIONS.has(getPreviewPathExtension(path));
}

export function isPreviewStylePath(path: string): boolean {
	return STYLE_EXTENSIONS.has(getPreviewPathExtension(path));
}

export function isPreviewModuleWrappedPath(path: string): boolean {
	const extension = getPreviewPathExtension(path);
	return STYLE_EXTENSIONS.has(extension) || MODULE_WRAPPED_EXTENSIONS.has(extension);
}

export function isPreviewUrlModulePath(path: string): boolean {
	return URL_MODULE_EXTENSIONS.has(getPreviewPathExtension(path));
}

export function isPreviewHotUpdatePath(path: string): boolean {
	return isPreviewJavaScriptPath(path) || isPreviewModuleWrappedPath(path) || isPreviewUrlModulePath(path);
}

export function toPreviewModuleId(path: string): string {
	const normalizedPath = normalizePreviewPath(path);
	if (isPreviewJavaScriptPath(normalizedPath)) {
		return normalizedPath;
	}
	if (isPreviewModuleWrappedPath(normalizedPath)) {
		return buildPreviewRequest(normalizedPath, { mode: 'module' });
	}
	if (isPreviewUrlModulePath(normalizedPath)) {
		return buildPreviewRequest(normalizedPath, { mode: 'url' });
	}
	return normalizedPath;
}

export function toPreviewImportRequest(path: string, timestamp: string | number | undefined): string {
	const moduleId = toPreviewModuleId(path);
	if (timestamp === undefined) {
		return moduleId;
	}
	return withPreviewTimestamp(moduleId, timestamp);
}

export function getPreviewUpdateTargets(path: string): PreviewUpdateTarget[] {
	const normalizedPath = normalizePreviewPath(path);
	if (isPreviewStylePath(normalizedPath)) {
		return [
			{ id: normalizedPath, kind: 'style-link' },
			{ id: buildPreviewRequest(normalizedPath, { mode: 'module' }), kind: 'module' },
		];
	}

	if (isPreviewJavaScriptPath(normalizedPath) || isPreviewModuleWrappedPath(normalizedPath) || isPreviewUrlModulePath(normalizedPath)) {
		return [{ id: toPreviewModuleId(normalizedPath), kind: 'module' }];
	}

	return [];
}
