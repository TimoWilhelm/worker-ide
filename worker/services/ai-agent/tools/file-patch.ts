/**
 * Tool: file_patch
 * Apply unified diff patches to files.
 */

import fs from 'node:fs/promises';

import { isPathSafe } from '../../../lib/path-utilities';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Apply a unified diff patch to a file. The patch should be in standard unified diff format.

Usage:
- The patch must be in unified diff format with @@ hunk headers.
- Context lines (starting with space) help locate the correct position.
- Lines starting with - are removed, lines starting with + are added.
- The file must already exist. Use write to create new files.`;

export const definition: ToolDefinition = {
	name: 'file_patch',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path to apply the patch to, starting with /' },
			patch: { type: 'string', description: 'Unified diff patch content' },
		},
		required: ['path', 'patch'],
	},
};

/**
 * Apply a unified diff patch to file content.
 * Returns the patched content, or undefined if the patch could not be applied.
 */
function applyUnifiedPatch(original: string, patch: string): string | undefined {
	const originalLines = original.split('\n');
	const patchLines = patch.split('\n');
	const resultLines = [...originalLines];
	let offset = 0;

	const hunkIndices: number[] = [];
	for (const [index, line] of patchLines.entries()) {
		if (/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
			hunkIndices.push(index);
		}
	}

	for (const hunkStart of hunkIndices) {
		const hunkMatch = patchLines[hunkStart].match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
		if (!hunkMatch) continue;

		const startLine = Number.parseInt(hunkMatch[1], 10) - 1;
		const removals: number[] = [];
		const additions: string[] = [];
		let position = startLine;

		for (const line of patchLines.slice(hunkStart + 1)) {
			if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('---') || line.startsWith('+++')) break;
			if (line.startsWith('-')) {
				removals.push(position + offset);
				position++;
			} else if (line.startsWith('+')) {
				additions.push(line.slice(1));
			} else if (line.startsWith(' ') || line === '') {
				position++;
			}
		}

		for (const removalIndex of removals.toReversed()) {
			if (removalIndex < 0 || removalIndex >= resultLines.length) return undefined;
			resultLines.splice(removalIndex, 1);
		}

		const insertAt = startLine + offset;
		resultLines.splice(insertAt, 0, ...additions);
		offset += additions.length - removals.length;
	}

	return resultLines.join('\n');
}

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	toolUseId?: string,
	queryChanges?: FileChange[],
): Promise<string | object> {
	const { projectRoot, projectId, environment } = context;
	const patchPath = input.path;
	const patchContent = input.patch;

	if (!isPathSafe(projectRoot, patchPath)) {
		return { error: 'Invalid file path' };
	}

	await sendEvent('status', { message: `Patching ${patchPath}...` });

	let originalContent: string;
	try {
		originalContent = await fs.readFile(`${projectRoot}${patchPath}`, 'utf8');
	} catch {
		return { error: `File not found: ${patchPath}` };
	}

	const patchedContent = applyUnifiedPatch(originalContent, patchContent);
	if (patchedContent === undefined) {
		return { error: `Failed to apply patch to ${patchPath}. The patch context may not match the current file content.` };
	}

	await fs.writeFile(`${projectRoot}${patchPath}`, patchedContent);

	if (queryChanges) {
		queryChanges.push({ path: patchPath, action: 'edit', beforeContent: originalContent, afterContent: patchedContent, isBinary: false });
	}

	const hmrId = environment.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
	const hmrStub = environment.DO_HMR_COORDINATOR.get(hmrId);
	const isCSS = patchPath.endsWith('.css');
	await hmrStub.fetch(
		new Request('http://internal/hmr/trigger', {
			method: 'POST',
			body: JSON.stringify({ type: isCSS ? 'update' : 'full-reload', path: patchPath, timestamp: Date.now(), isCSS }),
		}),
	);

	await sendEvent('file_changed', {
		path: patchPath,
		action: 'edit',
		tool_use_id: toolUseId,
		beforeContent: originalContent,
		afterContent: patchedContent,
		isBinary: false,
	});

	return { success: true, path: patchPath, action: 'edit' };
}
