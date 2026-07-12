import type { RuntimeBuild } from './types';

/** Validate cached or remote build output before passing it to a loader isolate. */
export function parseRuntimeBuild(value: unknown): RuntimeBuild | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	if (!('mainModule' in value) || !('serverModules' in value) || !('clientOutput' in value)) return undefined;
	const { mainModule, serverModules, clientOutput } = value;
	if (typeof mainModule !== 'string' || !isStringMap(serverModules) || !isStringMap(clientOutput)) return undefined;
	return { mainModule, serverModules, clientOutput };
}

function isStringMap(value: unknown): value is Record<string, string> {
	if (typeof value !== 'object' || value === null) return false;
	return Object.values(value).every((entry) => typeof entry === 'string');
}
