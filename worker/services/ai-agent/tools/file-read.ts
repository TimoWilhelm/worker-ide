/**
 * Tool: file_read
 * Read file contents from the project.
 */

import fs from 'node:fs/promises';

import { isPathSafe } from '../../../lib/path-utilities';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Read file contents. Supports optional line ranges for large files. Returns line-numbered content.

Usage:
- Always read relevant files before making changes to understand the existing code structure.
- Use offset and limit for large files instead of reading the entire file.
- offset is 1-indexed (first line is 1). limit is the number of lines to return.
- Returns content with line numbers in "N<tab><content>" format for easy reference.`;

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
