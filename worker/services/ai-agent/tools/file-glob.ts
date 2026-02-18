/**
 * Tool: file_glob
 * Find files by glob pattern matching.
 * Uses minimatch for proper glob support including brace expansion.
 */

import { minimatch } from 'minimatch';

import { listFilesRecursive } from '../tool-executor';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

// =============================================================================
// Constants
// =============================================================================

const MAX_RESULTS = 100;

// =============================================================================
// Description (matches OpenCode)
// =============================================================================

export const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.`;

// =============================================================================
// Tool Definition
// =============================================================================

export const definition: ToolDefinition = {
	name: 'file_glob',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'The glob pattern to match files against, e.g., **/*.ts, src/**/*.{ts,tsx}' },
			path: {
				type: 'string',
				description:
					'The directory to search in. If not specified, the project root will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior.',
			},
		},
		required: ['pattern'],
	},
};

// =============================================================================
// Execute Function
// =============================================================================

export async function execute(input: Record<string, string>, sendEvent: SendEventFunction, context: ToolExecutorContext): Promise<string> {
	const { projectRoot } = context;
	const globPattern = input.pattern;
	const searchPath = input.path || '/';

	await sendEvent('status', { message: `Finding files matching "${globPattern}"...` });

	// Get all files in the search directory
	const searchDirectory = searchPath === '/' ? projectRoot : `${projectRoot}${searchPath}`;
	const allFiles = await listFilesRecursive(searchDirectory);

	// Use minimatch for proper glob matching
	const matched = allFiles.filter((filepath) => {
		// Remove leading slash for matching
		const testPath = filepath.startsWith('/') ? filepath.slice(1) : filepath;
		// Also test the full path in case pattern includes leading components
		return (
			minimatch(testPath, globPattern, { matchBase: true, dot: true }) || minimatch(filepath, globPattern, { matchBase: true, dot: true })
		);
	});

	// Limit results
	const truncated = matched.length > MAX_RESULTS;
	const results = matched.slice(0, MAX_RESULTS);

	// Format results with full paths from search directory
	const formattedResults = results.map((f) => (searchPath === '/' ? f : `${searchPath}${f}`));

	// Build output
	const outputLines: string[] = [];

	if (results.length === 0) {
		outputLines.push('No files found');
	} else {
		outputLines.push(...formattedResults);

		if (truncated) {
			outputLines.push(
				'',
				`(Results are truncated: showing first ${MAX_RESULTS} results. Consider using a more specific path or pattern.)`,
			);
		}
	}

	return outputLines.join('\n');
}
