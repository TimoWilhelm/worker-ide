/**
 * Tool: file_read
 * Read file contents from the project.
 * Matches OpenCode's read tool behavior.
 */

import fs from 'node:fs/promises';

import { isPathSafe } from '../../../lib/path-utilities';
import { recordFileRead } from '../file-time';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

// =============================================================================
// Constants
// =============================================================================

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_OUTPUT_BYTES = 51_200; // 50KB

const BINARY_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.bmp',
	'.ico',
	'.webp',
	'.svg',
	'.pdf',
	'.zip',
	'.tar',
	'.gz',
	'.7z',
	'.rar',
	'.exe',
	'.dll',
	'.so',
	'.dylib',
	'.bin',
	'.dat',
	'.db',
	'.sqlite',
	'.woff',
	'.woff2',
	'.ttf',
	'.otf',
	'.eot',
	'.mp3',
	'.mp4',
	'.wav',
	'.avi',
	'.mov',
	'.webm',
	'.ogg',
	'.flac',
	'.class',
	'.jar',
	'.war',
	'.pyc',
	'.pyo',
	'.o',
	'.obj',
	'.a',
	'.lib',
	'.wasm',
]);

// =============================================================================
// Description (matches OpenCode)
// =============================================================================

export const DESCRIPTION = `Read a file or directory from the local filesystem. If the path does not exist, an error is returned.

Usage:
- The filePath parameter should be an absolute path.
- By default, this tool returns up to 2000 lines from the start of the file.
- The offset parameter is the line number to start from (1-indexed).
- To read later sections, call this tool again with a larger offset.
- Use the grep tool to find specific content in large files or files with long lines.
- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.
- Contents are returned with each line prefixed by its line number as \`<line>: <content>\`. For example, if a file has contents "foo\\n", you will receive "1: foo\\n". For directories, entries are returned one per line (without line numbers) with a trailing \`/\` for subdirectories.
- Any line longer than 2000 characters is truncated.
- Call this tool in parallel when you know there are multiple files you want to read.
- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.`;

// =============================================================================
// Tool Definition
// =============================================================================

export const definition: ToolDefinition = {
	name: 'file_read',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path starting with /, e.g., /src/main.ts' },
			offset: { type: 'string', description: 'The line number to start reading from (1-indexed). Defaults to 1.' },
			limit: { type: 'string', description: 'The maximum number of lines to read. Defaults to 2000.' },
		},
		required: ['path'],
	},
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a file is binary based on extension and content sampling.
 */
function isBinaryFile(filepath: string, content?: Buffer): boolean {
	// Check extension first
	const extension = filepath.slice(filepath.lastIndexOf('.')).toLowerCase();
	if (BINARY_EXTENSIONS.has(extension)) {
		return true;
	}

	// If we have content, sample it for binary characteristics
	if (content && content.length > 0) {
		const sampleSize = Math.min(4096, content.length);
		let nonPrintableCount = 0;

		for (let index = 0; index < sampleSize; index++) {
			const byte = content[index];
			// Null byte is a strong indicator of binary
			if (byte === 0) {
				return true;
			}
			// Count non-printable characters (excluding common whitespace)
			if (byte < 9 || (byte > 13 && byte < 32)) {
				nonPrintableCount++;
			}
		}

		// If more than 30% non-printable, consider it binary
		if (nonPrintableCount / sampleSize > 0.3) {
			return true;
		}
	}

	return false;
}

/**
 * Find similar files in the same directory when a file is not found.
 */
async function findSimilarFiles(projectRoot: string, filepath: string): Promise<string[]> {
	try {
		const directory = filepath.slice(0, filepath.lastIndexOf('/')) || '/';
		const filename = filepath.slice(filepath.lastIndexOf('/') + 1).toLowerCase();

		const entries = await fs.readdir(`${projectRoot}${directory}`);
		const similar: string[] = [];

		for (const entry of entries) {
			const entryLower = entry.toLowerCase();
			// Simple similarity: starts with same characters or contains the name
			if (entryLower.startsWith(filename.slice(0, 3)) || filename.includes(entryLower) || entryLower.includes(filename)) {
				similar.push(`${directory}/${entry}`);
			}
		}

		return similar.slice(0, 5); // Limit suggestions
	} catch {
		return [];
	}
}

// =============================================================================
// Execute Function
// =============================================================================

export async function execute(input: Record<string, string>, sendEvent: SendEventFunction, context: ToolExecutorContext): Promise<string> {
	const { projectRoot, sessionId } = context;
	const readPath = input.path;

	if (!isPathSafe(projectRoot, readPath)) {
		return `<error>Invalid file path: ${readPath}</error>`;
	}

	await sendEvent('status', { message: `Reading ${readPath}...` });

	const fullPath = `${projectRoot}${readPath}`;

	try {
		const stats = await fs.stat(fullPath);

		// Handle directory
		if (stats.isDirectory()) {
			const entries = await fs.readdir(fullPath, { withFileTypes: true });
			const formattedEntries = entries
				.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
				.toSorted((a, b) => {
					// Directories first, then alphabetical
					const aIsDirectory = a.endsWith('/');
					const bIsDirectory = b.endsWith('/');
					if (aIsDirectory && !bIsDirectory) return -1;
					if (!aIsDirectory && bIsDirectory) return 1;
					return a.localeCompare(b);
				})
				.join('\n');

			return `<path>${readPath}</path>
<type>directory</type>
<entries>
${formattedEntries}
</entries>`;
		}

		// Handle file
		const buffer = await fs.readFile(fullPath);

		// Check for binary file
		if (isBinaryFile(readPath, buffer)) {
			return `<path>${readPath}</path>
<type>binary</type>
<content>
Binary file detected. Cannot display content.
</content>`;
		}

		const fileContent = buffer.toString('utf8');
		const lines = fileContent.split('\n');
		const totalLines = lines.length;

		// Parse offset and limit
		const offset = input.offset ? Number.parseInt(input.offset, 10) : 1;
		const limit = input.limit ? Number.parseInt(input.limit, 10) : MAX_LINES;
		const effectiveLimit = Math.min(limit, MAX_LINES);

		const startIndex = Math.max(0, offset - 1);
		const endIndex = Math.min(totalLines, startIndex + effectiveLimit);
		const selectedLines = lines.slice(startIndex, endIndex);

		// Format lines with line numbers and apply truncation
		let outputBytes = 0;
		let truncatedAtLine: number | undefined;
		const numberedLines: string[] = [];

		for (const [index, originalLine] of selectedLines.entries()) {
			let line = originalLine;
			const lineNumber = startIndex + index + 1;

			// Truncate long lines
			if (line.length > MAX_LINE_LENGTH) {
				line = `${line.slice(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`;
			}

			const formattedLine = `${lineNumber}: ${line}`;
			const lineBytes = Buffer.byteLength(formattedLine, 'utf8') + 1; // +1 for newline

			// Check byte limit
			if (outputBytes + lineBytes > MAX_OUTPUT_BYTES) {
				truncatedAtLine = lineNumber;
				break;
			}

			outputBytes += lineBytes;
			numberedLines.push(formattedLine);
		}

		const content = numberedLines.join('\n');

		// Record that this file was read (for FileTime tracking)
		if (sessionId) {
			await recordFileRead(projectRoot, sessionId, readPath);
		}

		// Build output message
		let message = '';
		const actualEndLine = truncatedAtLine ? truncatedAtLine - 1 : endIndex;

		if (startIndex > 0 || actualEndLine < totalLines || truncatedAtLine) {
			message = `\n\n(Showing lines ${startIndex + 1}-${actualEndLine} of ${totalLines}.`;
			if (actualEndLine < totalLines) {
				message += ` Use offset=${actualEndLine + 1} to continue.`;
			}
			if (truncatedAtLine) {
				message += ` Output truncated due to size limit.`;
			}
			message += ')';
		}

		return `<path>${readPath}</path>
<type>file</type>
<content>
${content}${message}
</content>`;
	} catch {
		// File not found - try to suggest similar files
		const similar = await findSimilarFiles(projectRoot, readPath);
		let suggestion = '';
		if (similar.length > 0) {
			suggestion = `\n\nDid you mean one of these?\n${similar.map((f) => `  ${f}`).join('\n')}`;
		}

		return `<error>File not found: ${readPath}${suggestion}</error>`;
	}
}
