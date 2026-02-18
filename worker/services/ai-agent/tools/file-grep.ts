/**
 * Tool: file_grep
 * Search file contents using regular expressions.
 * Uses minimatch for include pattern filtering.
 */

import fs from 'node:fs/promises';

import { minimatch } from 'minimatch';

import { listFilesRecursive } from '../tool-executor';
import { isBinaryFilePath } from '../utilities';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

// =============================================================================
// Constants
// =============================================================================

const MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 2000;
const MAX_FILE_BYTES = 1_048_576; // 1 MB — skip files larger than this
const BATCH_SIZE = 10;

// =============================================================================
// Description (matches OpenCode)
// =============================================================================

export const DESCRIPTION = String.raw`- Fast content search tool that works with any codebase size
- Searches file contents using regular expressions
- Supports full regex syntax (eg. "log.*Error", "function\s+\w+", etc.)
- Filter files by pattern with the include parameter (eg. "*.js", "*.{ts,tsx}")
- Returns file paths and line numbers with at least one match sorted by modification time
- Use this tool when you need to find files containing specific patterns`;

// =============================================================================
// Tool Definition
// =============================================================================

export const definition: ToolDefinition = {
	name: 'file_grep',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'The regex pattern to search for in file contents' },
			path: { type: 'string', description: 'The directory to search in. Defaults to the project root.' },
			include: { type: 'string', description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")' },
		},
		required: ['pattern'],
	},
};

// =============================================================================
// Execute Function
// =============================================================================

export async function execute(input: Record<string, string>, sendEvent: SendEventFunction, context: ToolExecutorContext): Promise<string> {
	const { projectRoot } = context;
	const grepPattern = input.pattern;
	const searchPath = input.path || '/';
	const includePattern = input.include;

	await sendEvent('status', { message: `Searching for "${grepPattern}"...` });

	// Compile regex
	let regex: RegExp;
	try {
		regex = new RegExp(grepPattern, 'i');
	} catch {
		return `<error>Invalid regex pattern: ${grepPattern}</error>`;
	}

	// Get all files
	const searchDirectory = searchPath === '/' ? projectRoot : `${projectRoot}${searchPath}`;
	const allFiles = await listFilesRecursive(searchDirectory);

	// Filter by include pattern using minimatch
	let filesToSearch = allFiles;
	if (includePattern) {
		filesToSearch = allFiles.filter((filepath) => {
			const filename = filepath.slice(filepath.lastIndexOf('/') + 1);
			const testPath = filepath.startsWith('/') ? filepath.slice(1) : filepath;
			// Try matching against the filename and full path
			return (
				minimatch(filename, includePattern, { matchBase: true, dot: true }) ||
				minimatch(testPath, includePattern, { matchBase: true, dot: true })
			);
		});
	}

	// Search files in parallel batches to balance I/O throughput and memory usage
	interface Match {
		path: string;
		lineNumber: number;
		lineText: string;
	}

	const matches: Match[] = [];

	// Filter out binary files upfront
	const candidates = filesToSearch.filter((file) => !isBinaryFilePath(file));

	for (let batchStart = 0; batchStart < candidates.length && matches.length < MAX_MATCHES; batchStart += BATCH_SIZE) {
		const batch = candidates.slice(batchStart, batchStart + BATCH_SIZE);

		const batchResults = await Promise.all(
			batch.map(async (file): Promise<Match[]> => {
				try {
					const fullPath = searchPath === '/' ? `${projectRoot}${file}` : `${projectRoot}${searchPath}${file}`;

					// Skip large files to avoid excessive memory usage
					const stats = await fs.stat(fullPath);
					if (stats.size > MAX_FILE_BYTES) return [];

					const fileContent = await fs.readFile(fullPath, 'utf8');

					// Quick whole-file pre-test: skip line splitting if no match
					if (!regex.test(fileContent)) return [];

					const displayPath = searchPath === '/' ? file : `${searchPath}${file}`;
					const fileMatches: Match[] = [];
					const fileLines = fileContent.split('\n');

					for (const [lineIndex, lineText] of fileLines.entries()) {
						if (regex.test(lineText)) {
							const truncatedText = lineText.length > MAX_LINE_LENGTH ? `${lineText.slice(0, MAX_LINE_LENGTH)}...` : lineText;
							fileMatches.push({
								path: displayPath,
								lineNumber: lineIndex + 1,
								lineText: truncatedText,
							});
						}
					}

					return fileMatches;
				} catch {
					return [];
				}
			}),
		);

		// Collect results from the batch, stopping at MAX_MATCHES
		for (const fileMatches of batchResults) {
			for (const match of fileMatches) {
				matches.push(match);
				if (matches.length >= MAX_MATCHES) break;
			}
			if (matches.length >= MAX_MATCHES) break;
		}
	}

	// Format output (matches OpenCode style)
	if (matches.length === 0) {
		return 'No files found';
	}

	const totalMatches = matches.length;
	const truncated = totalMatches >= MAX_MATCHES;

	const outputLines = [`Found ${totalMatches} matches${truncated ? ` (showing first ${MAX_MATCHES})` : ''}`];

	// Group by file
	let currentFile = '';
	for (const match of matches) {
		if (currentFile !== match.path) {
			if (currentFile !== '') {
				outputLines.push('');
			}
			currentFile = match.path;
			outputLines.push(`${match.path}:`);
		}
		outputLines.push(`  Line ${match.lineNumber}: ${match.lineText}`);
	}

	if (truncated) {
		outputLines.push(
			'',
			`(Results truncated: showing ${MAX_MATCHES} of ${totalMatches} matches. Consider using a more specific path or pattern.)`,
		);
	}

	return outputLines.join('\n');
}
