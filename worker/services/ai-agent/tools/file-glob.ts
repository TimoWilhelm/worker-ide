/**
 * Tool: file_glob
 * Find files by glob pattern matching.
 */

import { listFilesRecursive } from '../tool-executor';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Find files matching a glob pattern. Returns matching file paths sorted by modification time. Results are capped at 100 files.

Usage:
- Use glob patterns like **/*.ts, src/**/*.tsx, or *.json.
- path defaults to the project root. Use it to narrow the search directory.
- Use this to discover files before reading or editing them.`;

export const definition: ToolDefinition = {
	name: 'file_glob',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'Glob pattern, e.g., **/*.ts, src/**/*.tsx' },
			path: { type: 'string', description: 'Directory to search in (default: project root). Starting with /' },
		},
		required: ['pattern'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<string | object> {
	const { projectRoot } = context;
	const globPattern = input.pattern;
	const globPath = input.path || '/';

	await sendEvent('status', { message: `Finding files matching "${globPattern}"...` });

	const allFiles = await listFilesRecursive(`${projectRoot}${globPath === '/' ? '' : globPath}`);

	const globRegex = new RegExp(
		'^' +
			globPattern
				.replaceAll('.', String.raw`\.`)
				.replaceAll('**/', '(.+/)?')
				.replaceAll('**', '.*')
				.replaceAll('*', '[^/]*')
				.replaceAll('?', '[^/]') +
			'$',
	);

	const matched = allFiles
		.filter((f) => {
			const testPath = f.startsWith('/') ? f.slice(1) : f;
			return globRegex.test(testPath) || globRegex.test(f);
		})
		.slice(0, 100);

	return { files: matched.map((f) => (globPath === '/' ? f : `${globPath}${f}`)), total: matched.length };
}
