export const projectDeepLinkPanels = ['editor', 'preview', 'git', 'agent', 'tests'] as const;

export type ProjectDeepLinkPanel = (typeof projectDeepLinkPanels)[number];

export interface ProjectDeepLinkFileLocation {
	path: string;
	line?: number;
	column?: number;
}

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
		case 'tests': {
			return true;
		}
		default: {
			return false;
		}
	}
}

function appendProjectDeepLinkParameters(searchParameters: URLSearchParams, target: ProjectDeepLinkTarget): void {
	if (target.kind === 'panel') {
		searchParameters.set('panel', target.panel);
		return;
	}

	if (target.kind === 'agent-session') {
		searchParameters.set('session', target.sessionId);
		return;
	}

	searchParameters.set('file', target.file.path);
	if (target.file.line !== undefined) {
		searchParameters.set('line', String(target.file.line));
		if (target.file.column !== undefined) {
			searchParameters.set('column', String(target.file.column));
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
				path: filePath,
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
