import type { ServerError } from '@shared/types';

/**
 * Strip esbuild/plugin noise from a build error message, keeping the
 * human-readable text. Removes `[plugin: …]` prefixes and `ERROR:` markers.
 */
export function cleanBuildErrorMessage(message: string): string {
	return message
		.replaceAll(/\[plugin: [^\]]+\]\s*/g, '')
		.replaceAll(/\bERROR:\s*/g, '')
		.trim();
}

/**
 * Convert a thrown build error into a `ServerError` for the preview error
 * overlay. esbuild formats failures as `file:line:col: ERROR: message`, so the
 * source location is parsed out when present.
 */
export function toBundleServerError(error: unknown): ServerError {
	const message = error instanceof Error ? error.message : String(error);
	const locationMatch = message.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);
	return {
		id: crypto.randomUUID(),
		timestamp: Date.now(),
		type: 'bundle',
		message: cleanBuildErrorMessage(locationMatch ? locationMatch[4] : message),
		location: locationMatch ? { file: locationMatch[1], line: Number(locationMatch[2]), column: Number(locationMatch[3]) } : undefined,
	};
}
