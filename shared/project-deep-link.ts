export const projectDeepLinkPanels = ['editor', 'preview', 'git', 'agent', 'tests', 'dependencies'] as const;

export type ProjectDeepLinkPanel = (typeof projectDeepLinkPanels)[number];

export interface ProjectDeepLinkFileLocation {
	path: string;
	line?: number;
	column?: number;
}

const projectDeepLinkParameterKeys = ['panel', 'session', 'file', 'line', 'column'] as const;

export type ProjectDeepLinkTarget =
	| {
			kind: 'panel';
			panel: ProjectDeepLinkPanel;
	  }
	| {
			kind: 'file';
			file: ProjectDeepLinkFileLocation;
	  }
	| {
			kind: 'agent-session';
			sessionId: string;
	  };

function normalizeProjectDeepLinkValue(value: string | null): string | undefined {
	const normalizedValue = value?.trim();
	return normalizedValue || undefined;
}

function parsePositiveInteger(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}

	const parsedValue = Number.parseInt(value, 10);
	if (!Number.isInteger(parsedValue) || parsedValue < 1) {
		return undefined;
	}

	return parsedValue;
}

export function normalizeProjectDeepLinkFilePath(path: string): string {
	const trimmedPath = path.trim();
	if (!trimmedPath) {
		return '/';
	}

	const withoutCurrentDirectoryPrefix = trimmedPath.replace(/^(?:\.\/)+/, '');
	const withSingleLeadingSlash = withoutCurrentDirectoryPrefix.startsWith('/')
		? `/${withoutCurrentDirectoryPrefix.replace(/^\/+/, '')}`
		: `/${withoutCurrentDirectoryPrefix}`;

	return withSingleLeadingSlash.replaceAll(/\/{2,}/g, '/');
}

export function normalizeProjectDeepLinkTarget(target: ProjectDeepLinkTarget): ProjectDeepLinkTarget {
	if (target.kind !== 'file') {
		return target;
	}

	return {
		kind: 'file',
		file: {
			...target.file,
			path: normalizeProjectDeepLinkFilePath(target.file.path),
		},
	};
}

function parseProjectDeepLinkPanel(value: string | null): ProjectDeepLinkPanel | undefined {
	const normalizedValue = normalizeProjectDeepLinkValue(value);
	if (!normalizedValue) {
		return undefined;
	}

	return projectDeepLinkPanels.find((panel) => panel === normalizedValue);
}

function isProjectDeepLinkPanelValue(value: unknown): value is ProjectDeepLinkPanel {
	if (typeof value !== 'string') {
		return false;
	}

	switch (value) {
		case 'editor':
		case 'preview':
		case 'git':
		case 'agent':
		case 'tests':
		case 'dependencies': {
			return true;
		}
		default: {
			return false;
		}
	}
}

function appendProjectDeepLinkParameters(searchParameters: URLSearchParams, target: ProjectDeepLinkTarget): void {
	const normalizedTarget = normalizeProjectDeepLinkTarget(target);

	if (normalizedTarget.kind === 'panel') {
		searchParameters.set('panel', normalizedTarget.panel);
		return;
	}

	if (normalizedTarget.kind === 'agent-session') {
		searchParameters.set('session', normalizedTarget.sessionId);
		return;
	}

	searchParameters.set('file', normalizedTarget.file.path);
	if (normalizedTarget.file.line !== undefined) {
		searchParameters.set('line', String(normalizedTarget.file.line));
		if (normalizedTarget.file.column !== undefined) {
			searchParameters.set('column', String(normalizedTarget.file.column));
		}
	}
}

export function serializeProjectDeepLinkTarget(target: ProjectDeepLinkTarget): string {
	const searchParameters = new URLSearchParams();
	appendProjectDeepLinkParameters(searchParameters, target);
	return searchParameters.toString();
}

export function buildProjectDeepLinkPath(projectId: string, target: ProjectDeepLinkTarget): string {
	const serializedTarget = serializeProjectDeepLinkTarget(target);
	return serializedTarget ? `/p/${projectId}?${serializedTarget}` : `/p/${projectId}`;
}

export function clearProjectDeepLinkSearchParameters(searchParameters: URLSearchParams): URLSearchParams {
	const nextSearchParameters = new URLSearchParams(searchParameters);
	for (const parameterKey of projectDeepLinkParameterKeys) {
		nextSearchParameters.delete(parameterKey);
	}

	return nextSearchParameters;
}

export function parseProjectDeepLink(searchParameters: URLSearchParams): ProjectDeepLinkTarget | undefined {
	const sessionId = normalizeProjectDeepLinkValue(searchParameters.get('session'));
	if (sessionId) {
		return { kind: 'agent-session', sessionId };
	}

	const filePath = normalizeProjectDeepLinkValue(searchParameters.get('file'));
	if (filePath) {
		const line = parsePositiveInteger(searchParameters.get('line'));
		const column = parsePositiveInteger(searchParameters.get('column'));

		return {
			kind: 'file',
			file: {
				path: normalizeProjectDeepLinkFilePath(filePath),
				...(line === undefined ? {} : { line, ...(column === undefined ? {} : { column }) }),
			},
		};
	}

	const panel = parseProjectDeepLinkPanel(searchParameters.get('panel'));
	if (panel) {
		return { kind: 'panel', panel };
	}

	return undefined;
}

export function isProjectDeepLinkTarget(value: unknown): value is ProjectDeepLinkTarget {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const kind = Reflect.get(value, 'kind');
	if (kind === 'agent-session') {
		return typeof Reflect.get(value, 'sessionId') === 'string';
	}

	if (kind === 'panel') {
		const panel = Reflect.get(value, 'panel');
		return isProjectDeepLinkPanelValue(panel);
	}

	if (kind !== 'file') {
		return false;
	}

	const file = Reflect.get(value, 'file');
	if (typeof file !== 'object' || file === null) {
		return false;
	}

	const path = Reflect.get(file, 'path');
	const line = Reflect.get(file, 'line');
	const column = Reflect.get(file, 'column');

	return (
		typeof path === 'string' && (line === undefined || typeof line === 'number') && (column === undefined || typeof column === 'number')
	);
}
