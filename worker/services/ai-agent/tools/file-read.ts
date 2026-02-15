/**
 * Tool: file_read
 * Read file contents from the project.
 */

import fs from 'node:fs/promises';

import { isPathSafe } from '../../../lib/path-utilities';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Read a file from the project. Returns line-numbered content.

Usage:
- Always read relevant files before making changes to understand the existing code structure.
- By default returns the full file. Use offset and limit for large files to read specific sections.
- offset is 1-indexed (first line is 1). limit is the number of lines to return.
- Returns content with each line prefixed by its line number as "N<tab><content>".
- Call this tool in parallel when you know there are multiple files you want to read.
- Avoid tiny repeated slices. If you need more context, read a larger window.
- Use the file_grep tool to find specific content in large files.
- If you are unsure of the correct file path, use the file_glob tool to look up filenames by pattern.`;

export const definition: ToolDefinition = {
	name: 'file_read',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path starting with /, e.g., /src/main.ts' },
			offset: { type: 'string', description: 'Start line number (1-indexed). Omit to read from the beginning.' },
			limit: { type: 'string', description: 'Number of lines to read. Omit to read to the end.' },
		},
		required: ['path'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<string | object> {
	const { projectRoot } = context;
	const readPath = input.path;

	if (!isPathSafe(projectRoot, readPath)) {
		return { error: 'Invalid file path' };
	}

	await sendEvent('status', { message: `Reading ${readPath}...` });

	try {
		const fileContent = await fs.readFile(`${projectRoot}${readPath}`, 'utf8');
		const lines = fileContent.split('\n');
		const offset = input.offset ? Number.parseInt(input.offset, 10) : 1;
		const limit = input.limit ? Number.parseInt(input.limit, 10) : lines.length;

		const startIndex = Math.max(0, offset - 1);
		const endIndex = Math.min(lines.length, startIndex + limit);
		const selectedLines = lines.slice(startIndex, endIndex);

		const numbered = selectedLines.map((line, index) => `${startIndex + index + 1}\t${line}`).join('\n');
		return {
			path: readPath,
			content: numbered,
			totalLines: lines.length,
			startLine: startIndex + 1,
			endLine: endIndex,
		};
	} catch {
		return { error: `File not found: ${readPath}` };
	}
}
