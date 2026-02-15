/**
 * Tool: file_list
 * List files and directories in a given path.
 */

import fs from 'node:fs/promises';

import { HIDDEN_ENTRIES } from '@shared/constants';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `List files and directories in a given path. Returns immediate children with type and size information.

Usage:
- path defaults to /. Lists immediate children (files and directories) with sizes.
- Use pattern to filter entries by glob, e.g., "*.ts".
- For recursive listing of all files in the project, use the files_list tool instead.
- For finding files by name pattern across the tree, use the file_glob tool instead.`;

export const definition: ToolDefinition = {
	name: 'file_list',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Directory path starting with / (default: /)' },
			pattern: { type: 'string', description: 'Optional glob pattern to filter entries' },
		},
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<string | object> {
	const { projectRoot } = context;
	const listPath = input.path || '/';
	const listPattern = input.pattern;

	await sendEvent('status', { message: `Listing ${listPath}...` });

	try {
		const entries = await fs.readdir(`${projectRoot}${listPath}`, { withFileTypes: true });
		let results: Array<{ name: string; type: 'file' | 'directory'; size?: number }> = [];

		for (const entry of entries) {
			if (HIDDEN_ENTRIES.has(entry.name)) continue;

			const entryType = entry.isDirectory() ? 'directory' : 'file';
			let size: number | undefined;
			if (!entry.isDirectory()) {
				try {
					const stat = await fs.stat(`${projectRoot}${listPath}/${entry.name}`);
					size = stat.size;
				} catch {
					// No-op
				}
			}
			results.push({ name: entry.name, type: entryType, size });
		}

		if (listPattern) {
			const patternRegex = new RegExp(
				listPattern
					.replaceAll('.', String.raw`\.`)
					.replaceAll('*', '.*')
					.replaceAll('?', '.'),
				'i',
			);
			results = results.filter((entry) => patternRegex.test(entry.name));
		}

		return { path: listPath, entries: results };
	} catch {
		return { error: `Directory not found: ${listPath}` };
	}
}
