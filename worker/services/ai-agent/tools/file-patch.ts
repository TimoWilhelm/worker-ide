/**
 * Tool: file_patch
 * Apply patches to files using a simplified patch format.
 * Implements OpenCode's patch format which is optimized for AI-generated diffs.
 */

import fs from 'node:fs/promises';

import { exports } from 'cloudflare:workers';

import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { isPathSafe } from '../../../lib/path-utilities';
import { assertFileWasRead, recordFileRead } from '../file-time';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

// =============================================================================
// Description (matches OpenCode's apply_patch)
// =============================================================================

export const DESCRIPTION = `Use the file_patch tool to edit files. Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Example patch:

\`\`\`
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
\`\`\`

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file`;

// =============================================================================
// Types
// =============================================================================

interface AddHunk {
	type: 'add';
	path: string;
	contents: string;
}

interface DeleteHunk {
	type: 'delete';
	path: string;
}

interface UpdateFileChunk {
	oldLines: string[];
	newLines: string[];
	changeContext?: string;
	isEndOfFile?: boolean;
}

interface UpdateHunk {
	type: 'update';
	path: string;
	movePath?: string;
	chunks: UpdateFileChunk[];
}

type Hunk = AddHunk | DeleteHunk | UpdateHunk;

// =============================================================================
// Tool Definition
// =============================================================================

export const definition: ToolDefinition = {
	name: 'file_patch',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			patch: { type: 'string', description: 'The full patch text that describes all changes to be made' },
		},
		required: ['patch'],
	},
};

// =============================================================================
// Patch Parser
// =============================================================================

/**
 * Extract the path value after a known prefix like "*** Add File: "
 */
function extractPathAfterPrefix(line: string, prefix: string): string | undefined {
	const value = line.slice(prefix.length).trim();
	return value.length > 0 ? value : undefined;
}

/**
 * Parse a patch header line
 */
function parsePatchHeader(lines: string[], startIndex: number): { filePath: string; movePath?: string; nextIndex: number } | undefined {
	const line = lines[startIndex];

	if (line.startsWith('*** Add File:')) {
		const filePath = extractPathAfterPrefix(line, '*** Add File:');
		return filePath ? { filePath, nextIndex: startIndex + 1 } : undefined;
	}

	if (line.startsWith('*** Delete File:')) {
		const filePath = extractPathAfterPrefix(line, '*** Delete File:');
		return filePath ? { filePath, nextIndex: startIndex + 1 } : undefined;
	}

	if (line.startsWith('*** Update File:')) {
		const filePath = extractPathAfterPrefix(line, '*** Update File:');
		let movePath: string | undefined;
		let nextIndex = startIndex + 1;

		// Check for move directive
		if (nextIndex < lines.length && lines[nextIndex].startsWith('*** Move to:')) {
			movePath = extractPathAfterPrefix(lines[nextIndex], '*** Move to:');
			nextIndex++;
		}

		return filePath ? { filePath, movePath, nextIndex } : undefined;
	}

	return undefined;
}

/**
 * Parse update file chunks
 */
function parseUpdateFileChunks(lines: string[], startIndex: number): { chunks: UpdateFileChunk[]; nextIndex: number } {
	const chunks: UpdateFileChunk[] = [];
	let index = startIndex;

	while (index < lines.length && !lines[index].startsWith('***')) {
		if (lines[index].startsWith('@@')) {
			// Parse context line
			const contextLine = lines[index].slice(2).trim();
			index++;

			const oldLines: string[] = [];
			const newLines: string[] = [];
			let isEndOfFile = false;

			// Parse change lines
			// Note: we allow "*** End of File" through the outer condition since it's
			// a valid marker inside a hunk, unlike other *** prefixed lines.
			while (
				index < lines.length &&
				!lines[index].startsWith('@@') &&
				!(lines[index].startsWith('***') && lines[index] !== '*** End of File')
			) {
				const changeLine = lines[index];

				if (changeLine === '*** End of File') {
					isEndOfFile = true;
					index++;
					break;
				}

				if (changeLine.startsWith(' ')) {
					// Keep line - appears in both old and new
					const content = changeLine.slice(1);
					oldLines.push(content);
					newLines.push(content);
				} else if (changeLine.startsWith('-')) {
					// Remove line - only in old
					oldLines.push(changeLine.slice(1));
				} else if (changeLine.startsWith('+')) {
					// Add line - only in new
					newLines.push(changeLine.slice(1));
				}

				index++;
			}

			chunks.push({
				oldLines,
				newLines,
				changeContext: contextLine || undefined,
				isEndOfFile: isEndOfFile || undefined,
			});
		} else {
			index++;
		}
	}

	return { chunks, nextIndex: index };
}

/**
 * Parse add file content
 */
function parseAddFileContent(lines: string[], startIndex: number): { content: string; nextIndex: number } {
	let content = '';
	let index = startIndex;

	while (index < lines.length && !lines[index].startsWith('***')) {
		if (lines[index].startsWith('+')) {
			content += lines[index].slice(1) + '\n';
		}
		index++;
	}

	// Remove trailing newline
	if (content.endsWith('\n')) {
		content = content.slice(0, -1);
	}

	return { content, nextIndex: index };
}

/**
 * Parse patch text into hunks
 */
/**
 * Strip heredoc wrappers (e.g. cat <<'EOF'\n...\nEOF) from patch text.
 */
function stripHeredoc(input: string): string {
	const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	if (heredocMatch) {
		return heredocMatch[2];
	}
	return input;
}

function parsePatch(patchText: string): { hunks: Hunk[] } {
	const cleaned = stripHeredoc(patchText.trim());
	const lines = cleaned.split('\n');
	const hunks: Hunk[] = [];

	// Look for Begin/End patch markers
	const beginMarker = '*** Begin Patch';
	const endMarker = '*** End Patch';

	const beginIndex = lines.findIndex((line) => line.trim() === beginMarker);
	const endIndex = lines.findIndex((line) => line.trim() === endMarker);

	if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
		throw new Error('Invalid patch format: missing Begin/End markers');
	}

	// Parse content between markers
	let index = beginIndex + 1;

	while (index < endIndex) {
		const header = parsePatchHeader(lines, index);
		if (!header) {
			index++;
			continue;
		}

		if (lines[index].startsWith('*** Add File:')) {
			const { content, nextIndex } = parseAddFileContent(lines, header.nextIndex);
			hunks.push({
				type: 'add',
				path: header.filePath,
				contents: content,
			});
			index = nextIndex;
		} else if (lines[index].startsWith('*** Delete File:')) {
			hunks.push({
				type: 'delete',
				path: header.filePath,
			});
			index = header.nextIndex;
		} else if (lines[index].startsWith('*** Update File:')) {
			const { chunks, nextIndex } = parseUpdateFileChunks(lines, header.nextIndex);
			hunks.push({
				type: 'update',
				path: header.filePath,
				movePath: header.movePath,
				chunks,
			});
			index = nextIndex;
		} else {
			index++;
		}
	}

	return { hunks };
}

// =============================================================================
// Line Matching (with fuzzy matching for robustness)
// =============================================================================

type Comparator = (a: string, b: string) => boolean;

function tryMatch(lines: string[], pattern: string[], startIndex: number, compare: Comparator, endOfFile: boolean): number {
	// If EOF anchor, try matching from end of file first
	if (endOfFile) {
		const fromEnd = lines.length - pattern.length;
		if (fromEnd >= startIndex) {
			let matches = true;
			for (const [index, element] of pattern.entries()) {
				if (!compare(lines[fromEnd + index], element)) {
					matches = false;
					break;
				}
			}
			if (matches) return fromEnd;
		}
	}

	// Forward search from startIndex
	for (let index = startIndex; index <= lines.length - pattern.length; index++) {
		let matches = true;
		for (const [patternIndex, element] of pattern.entries()) {
			if (!compare(lines[index + patternIndex], element)) {
				matches = false;
				break;
			}
		}
		if (matches) return index;
	}

	return -1;
}

/**
 * Normalize Unicode punctuation to ASCII equivalents
 */
function normalizeUnicode(string_: string): string {
	return string_
		.replaceAll(/[\u2018\u2019\u201A\u201B]/g, "'") // single quotes
		.replaceAll(/[\u201C\u201D\u201E\u201F]/g, '"') // double quotes
		.replaceAll(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-') // dashes
		.replaceAll('\u2026', '...') // ellipsis
		.replaceAll('\u00A0', ' '); // non-breaking space
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, endOfFile = false): number {
	if (pattern.length === 0) return -1;

	// Pass 1: exact match
	const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, endOfFile);
	if (exact !== -1) return exact;

	// Pass 2: rstrip (trim trailing whitespace)
	const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), endOfFile);
	if (rstrip !== -1) return rstrip;

	// Pass 3: trim (both ends)
	const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), endOfFile);
	if (trim !== -1) return trim;

	// Pass 4: normalized (Unicode punctuation to ASCII)
	const normalized = tryMatch(lines, pattern, startIndex, (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()), endOfFile);
	return normalized;
}

// =============================================================================
// Patch Application
// =============================================================================

/**
 * Compute replacements for update chunks
 */
function computeReplacements(originalLines: string[], filePath: string, chunks: UpdateFileChunk[]): Array<[number, number, string[]]> {
	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		// Handle context-based seeking
		if (chunk.changeContext) {
			const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex);
			if (contextIndex === -1) {
				throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
			}
			lineIndex = contextIndex + 1;
		}

		// Handle pure addition (no old lines)
		if (chunk.oldLines.length === 0) {
			const insertionIndex = originalLines.length > 0 && originalLines.at(-1) === '' ? originalLines.length - 1 : originalLines.length;
			replacements.push([insertionIndex, 0, chunk.newLines]);
			continue;
		}

		// Try to match old lines in the file
		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

		// Retry without trailing empty line if not found
		if (found === -1 && pattern.length > 0 && pattern.at(-1) === '') {
			pattern = pattern.slice(0, -1);
			if (newSlice.length > 0 && newSlice.at(-1) === '') {
				newSlice = newSlice.slice(0, -1);
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (found === -1) {
			throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}`);
		} else {
			replacements.push([found, pattern.length, newSlice]);
			lineIndex = found + pattern.length;
		}
	}

	// Sort replacements by index to apply in order
	replacements.sort((a, b) => a[0] - b[0]);

	return replacements;
}

/**
 * Apply replacements to lines
 */
function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
	// Apply replacements in reverse order to avoid index shifting
	const result = [...lines];

	for (let index = replacements.length - 1; index >= 0; index--) {
		const [startIndex, oldLength, newSegment] = replacements[index];

		// Remove old lines
		result.splice(startIndex, oldLength);

		// Insert new lines
		for (const [newIndex, element] of newSegment.entries()) {
			result.splice(startIndex + newIndex, 0, element);
		}
	}

	return result;
}

/**
 * Derive new file contents from update chunks
 */
function deriveNewContentsFromChunks(filePath: string, originalContent: string, chunks: UpdateFileChunk[]): string {
	const originalLines = originalContent.split('\n');

	// Drop trailing empty element for consistent line counting
	if (originalLines.length > 0 && originalLines.at(-1) === '') {
		originalLines.pop();
	}

	const replacements = computeReplacements(originalLines, filePath, chunks);
	const newLines = applyReplacements(originalLines, replacements);

	// Ensure trailing newline
	if (newLines.length === 0 || newLines.at(-1) !== '') {
		newLines.push('');
	}

	return newLines.join('\n');
}

// =============================================================================
// Execute Function
// =============================================================================

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	toolUseId?: string,
	queryChanges?: FileChange[],
): Promise<string> {
	const { projectRoot, projectId, sessionId } = context;
	const patchText = input.patch;

	if (!patchText) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'patch is required');
	}

	await sendEvent('status', { message: 'Applying patch...' });

	// Parse the patch
	let hunks: Hunk[];
	try {
		const parseResult = parsePatch(patchText);
		hunks = parseResult.hunks;
	} catch (error) {
		return toolError(ToolErrorCode.PATCH_PARSE_FAILED, `Patch parse failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}

	if (hunks.length === 0) {
		return toolError(ToolErrorCode.PATCH_REJECTED, 'Patch rejected: no file operations found');
	}

	// Validate all paths first
	for (const hunk of hunks) {
		if (!hunk.path.startsWith('/')) {
			return toolError(ToolErrorCode.INVALID_PATH, `Invalid path: ${hunk.path}. Paths must start with /`);
		}
		if (!isPathSafe(projectRoot, hunk.path)) {
			return toolError(ToolErrorCode.INVALID_PATH, `Invalid file path: ${hunk.path}`);
		}
		if (hunk.type === 'update' && hunk.movePath) {
			if (!hunk.movePath.startsWith('/')) {
				return toolError(ToolErrorCode.INVALID_PATH, `Invalid move path: ${hunk.movePath}. Paths must start with /`);
			}
			if (!isPathSafe(projectRoot, hunk.movePath)) {
				return toolError(ToolErrorCode.INVALID_PATH, `Invalid move path: ${hunk.movePath}`);
			}
		}
	}

	// Phase 1: Validate all hunks and compute new contents before writing anything.
	// This prevents partial application leaving the filesystem in an inconsistent state.
	const fileChanges: Array<{
		hunk: Hunk;
		oldContent: string;
		newContent: string;
		targetPath: string;
	}> = [];

	for (const hunk of hunks) {
		try {
			switch (hunk.type) {
				case 'add': {
					const newContent = hunk.contents.length === 0 || hunk.contents.endsWith('\n') ? hunk.contents : `${hunk.contents}\n`;
					fileChanges.push({ hunk, oldContent: '', newContent, targetPath: hunk.path });
					break;
				}

				case 'delete': {
					let oldContent: string;
					try {
						oldContent = await fs.readFile(`${projectRoot}${hunk.path}`, 'utf8');
					} catch {
						return toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found for deletion: ${hunk.path}`);
					}
					fileChanges.push({ hunk, oldContent, newContent: '', targetPath: hunk.path });
					break;
				}

				case 'update': {
					if (sessionId) {
						try {
							await assertFileWasRead(projectRoot, sessionId, hunk.path);
						} catch (error) {
							return toolError(
								ToolErrorCode.FILE_NOT_READ,
								error instanceof Error ? error.message : 'You must read the file before patching it.',
							);
						}
					}

					let oldContent: string;
					try {
						oldContent = await fs.readFile(`${projectRoot}${hunk.path}`, 'utf8');
					} catch {
						return toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found for update: ${hunk.path}`);
					}

					const newContent = deriveNewContentsFromChunks(hunk.path, oldContent, hunk.chunks);
					const targetPath = hunk.movePath ?? hunk.path;
					fileChanges.push({ hunk, oldContent, newContent, targetPath });
					break;
				}
			}
		} catch (error) {
			return toolError(
				ToolErrorCode.PATCH_APPLY_FAILED,
				`Failed to verify hunk for ${hunk.path}: ${error instanceof Error ? error.message : 'Unknown error'}`,
			);
		}
	}

	// Phase 2: Apply all validated changes to the filesystem.
	const results: string[] = [];

	for (const { hunk, oldContent, newContent, targetPath } of fileChanges) {
		switch (hunk.type) {
			case 'add': {
				const addDirectory = hunk.path.slice(0, hunk.path.lastIndexOf('/'));
				if (addDirectory) {
					await fs.mkdir(`${projectRoot}${addDirectory}`, { recursive: true });
				}
				await fs.writeFile(`${projectRoot}${hunk.path}`, newContent);

				if (sessionId) {
					await recordFileRead(projectRoot, sessionId, hunk.path);
				}

				if (queryChanges) {
					// eslint-disable-next-line unicorn/no-null -- JSON wire format
					queryChanges.push({ path: hunk.path, action: 'create', beforeContent: null, afterContent: newContent, isBinary: false });
				}

				await sendEvent('file_changed', {
					path: hunk.path,
					action: 'create',
					tool_use_id: toolUseId,
					// eslint-disable-next-line unicorn/no-null -- JSON wire format
					beforeContent: null,
					afterContent: newContent,
					isBinary: false,
				});

				results.push(`A ${hunk.path}`);
				break;
			}

			case 'delete': {
				await fs.unlink(`${projectRoot}${hunk.path}`);

				if (queryChanges) {
					// eslint-disable-next-line unicorn/no-null -- JSON wire format
					queryChanges.push({ path: hunk.path, action: 'delete', beforeContent: oldContent, afterContent: null, isBinary: false });
				}

				await sendEvent('file_changed', {
					path: hunk.path,
					action: 'delete',
					tool_use_id: toolUseId,
					beforeContent: oldContent,
					// eslint-disable-next-line unicorn/no-null -- JSON wire format
					afterContent: null,
					isBinary: false,
				});

				results.push(`D ${hunk.path}`);
				break;
			}

			case 'update': {
				// Guard: skip no-op updates where the patch produces identical content.
				// Moves always proceed (the path changes even if content doesn't).
				if (!hunk.movePath && oldContent === newContent) {
					results.push(`S ${targetPath} (no changes)`);
					break;
				}

				if (hunk.movePath) {
					const moveDirectory = hunk.movePath.slice(0, hunk.movePath.lastIndexOf('/'));
					if (moveDirectory) {
						await fs.mkdir(`${projectRoot}${moveDirectory}`, { recursive: true });
					}

					await fs.writeFile(`${projectRoot}${hunk.movePath}`, newContent);
					await fs.unlink(`${projectRoot}${hunk.path}`);

					if (sessionId) {
						await recordFileRead(projectRoot, sessionId, hunk.movePath);
					}

					if (queryChanges) {
						/* eslint-disable unicorn/no-null -- WebSocket wire format uses null */
						queryChanges.push(
							{ path: hunk.path, action: 'delete', beforeContent: oldContent, afterContent: null, isBinary: false },
							{ path: hunk.movePath, action: 'create', beforeContent: null, afterContent: newContent, isBinary: false },
						);
						/* eslint-enable unicorn/no-null */
					}

					await sendEvent('file_changed', {
						path: hunk.movePath,
						action: 'create',
						tool_use_id: toolUseId,
						beforeContent: oldContent,
						afterContent: newContent,
						isBinary: false,
					});

					results.push(`M ${hunk.path} -> ${hunk.movePath}`);
				} else {
					await fs.writeFile(`${projectRoot}${hunk.path}`, newContent);

					if (sessionId) {
						await recordFileRead(projectRoot, sessionId, hunk.path);
					}

					if (queryChanges) {
						queryChanges.push({
							path: hunk.path,
							action: 'edit',
							beforeContent: oldContent,
							afterContent: newContent,
							isBinary: false,
						});
					}

					await sendEvent('file_changed', {
						path: hunk.path,
						action: 'edit',
						tool_use_id: toolUseId,
						beforeContent: oldContent,
						afterContent: newContent,
						isBinary: false,
					});

					results.push(`M ${targetPath}`);
				}
				break;
			}
		}
	}

	// Trigger live reload for all affected files
	const coordinatorId = exports.ProjectCoordinator.idFromName(`project:${projectId}`);
	const coordinatorStub = exports.ProjectCoordinator.get(coordinatorId);
	await coordinatorStub.triggerUpdate({
		type: 'full-reload',
		path: '/',
		timestamp: Date.now(),
		isCSS: false,
	});

	return `Success. Updated the following files:\n${results.join('\n')}`;
}
