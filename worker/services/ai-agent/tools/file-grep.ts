/**
 * Tool: file_grep
 * Search file contents using regular expressions.
 */

import fs from 'node:fs/promises';

import { listFilesRecursive } from '../tool-executor';
import { isBinaryFilePath } from '../utilities';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Search file contents using regular expressions. Returns matching file paths with line numbers and context. Results are capped at 50 files.

Usage:
- Use this to find relevant code before making changes.
- pattern is a JavaScript regular expression by default (case-insensitive).
- Set fixed_strings to "true" to treat pattern as a literal string (no regex).
- Use include to filter by file extension, e.g., "*.ts" or "*.tsx".
- path defaults to the project root. Use it to narrow the search directory.
- Returns up to 10 matches per file, 50 files total.`;

export const definition: ToolDefinition = {
	name: 'file_grep',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'Regex pattern to search for' },
			path: { type: 'string', description: 'Directory to search in (default: project root). Starting with /' },
			include: { type: 'string', description: 'Glob filter for files, e.g., "*.ts" or "*.tsx"' },
			fixed_strings: { type: 'string', description: 'Set to "true" to treat pattern as a literal string' },
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
	const grepPattern = input.pattern;
	const grepPath = input.path || '/';
	const grepInclude = input.include;
	const grepFixedStrings = input.fixed_strings === 'true';

	await sendEvent('status', { message: `Searching for "${grepPattern}"...` });

	let regex: RegExp;
	try {
		regex = grepFixedStrings
			? new RegExp(grepPattern.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), 'i')
			: new RegExp(grepPattern, 'i');
	} catch {
		return { error: `Invalid regex pattern: ${grepPattern}` };
	}

	const allFiles = await listFilesRecursive(`${projectRoot}${grepPath === '/' ? '' : grepPath}`);
	let filesToSearch = allFiles;

	if (grepInclude) {
		const includePattern = grepInclude.replaceAll('.', String.raw`\.`).replaceAll('*', '.*');
		const includeRegex = new RegExp(`${includePattern}$`, 'i');
		filesToSearch = filesToSearch.filter((f) => includeRegex.test(f));
	}

	const results: Array<{ file: string; matches: Array<{ line: number; content: string }> }> = [];
	const maxFiles = 50;
	const maxMatchesPerFile = 10;

	for (const file of filesToSearch) {
		if (results.length >= maxFiles) break;
		if (isBinaryFilePath(file)) continue;

		try {
			const fullPath = grepPath === '/' ? `${projectRoot}${file}` : `${projectRoot}${grepPath}${file}`;
			const fileContent = await fs.readFile(fullPath, 'utf8');
			const fileLines = fileContent.split('\n');
			const matches: Array<{ line: number; content: string }> = [];

			for (const [lineIndex, lineText] of fileLines.entries()) {
				if (matches.length >= maxMatchesPerFile) break;
				if (regex.test(lineText)) {
					matches.push({ line: lineIndex + 1, content: lineText.slice(0, 200) });
				}
			}

			if (matches.length > 0) {
				const displayPath = grepPath === '/' ? file : `${grepPath}${file}`;
				results.push({ file: displayPath, matches });
			}
		} catch {
			// Skip unreadable files
		}
	}

	return { results, totalFiles: results.length };
}
