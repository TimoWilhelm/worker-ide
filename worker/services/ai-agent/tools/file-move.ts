/**
 * Tool: file_move
 * Move or rename a file.
 */

import fs from 'node:fs/promises';

import { MAX_DIAGNOSTICS_PER_FILE } from '@shared/constants';
import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { coordinatorNamespace } from '../../../lib/durable-object-namespaces';
import { isHiddenPath, isPathSafe, isProtectedFile } from '../../../lib/path-utilities';
import { formatLintDiagnostics, lintFileForAgent } from '../lib/biome-linter';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const DESCRIPTION = `Move or rename a file within the project.

Usage:
- Both from_path and to_path must start with /.
- Parent directories for the destination are created automatically.
- Protected system files cannot be moved.
- Triggers a full reload after the move so the preview updates.
- Remember to update any import paths in other files that reference the moved file.`;

export const definition: ToolDefinition = {
	name: 'file_move',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			from_path: { type: 'string', description: 'Current file path' },
			to_path: { type: 'string', description: 'New file path' },
		},
		required: ['from_path', 'to_path'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges?: FileChange[],
): Promise<ToolResult> {
	const { projectRoot, projectId } = context;
	const fromPath = input.from_path;
	const toPath = input.to_path;

	if (!isPathSafe(projectRoot, fromPath) || !isPathSafe(projectRoot, toPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, 'Invalid file path');
	}
	if (isHiddenPath(fromPath) || isHiddenPath(toPath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Access denied: hidden path`);
	}
	if (isProtectedFile(fromPath)) {
		return toolError(ToolErrorCode.NOT_ALLOWED, `Cannot move protected file: ${fromPath}`);
	}

	sendEvent('status', { message: `Moving ${fromPath} → ${toPath}...` });

	let beforeContent: string;
	try {
		beforeContent = await fs.readFile(`${projectRoot}${fromPath}`, 'utf8');
	} catch {
		return toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found: ${fromPath}`);
	}

	const toDirectory = toPath.slice(0, toPath.lastIndexOf('/'));
	if (toDirectory) {
		await fs.mkdir(`${projectRoot}${toDirectory}`, { recursive: true });
	}
	await fs.rename(`${projectRoot}${fromPath}`, `${projectRoot}${toPath}`);

	if (queryChanges) {
		queryChanges.push(
			// eslint-disable-next-line unicorn/no-null -- JSON wire format
			{ path: fromPath, action: 'delete', beforeContent, afterContent: null, isBinary: false },
			// eslint-disable-next-line unicorn/no-null -- JSON wire format
			{ path: toPath, action: 'create', beforeContent: null, afterContent: beforeContent, isBinary: false },
		);
	}

	const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
	const coordinatorStub = coordinatorNamespace.get(coordinatorId);
	await coordinatorStub.triggerUpdate({ type: 'full-reload', path: toPath, timestamp: Date.now(), isCSS: false });

	sendEvent('file_changed', {
		path: `${fromPath} → ${toPath}`,
		action: 'move',
	});

	// Lint the file at its new path so the agent sees any diagnostics
	const allDiagnostics = await lintFileForAgent(toPath, beforeContent);
	const diagnostics = allDiagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);

	const byteCount = Buffer.byteLength(beforeContent, 'utf8');
	let output = `Moved ${fromPath} → ${toPath} (${byteCount} bytes). Remember to update any import paths that reference the old location.`;
	const lintOutput = formatLintDiagnostics(diagnostics);
	if (lintOutput) {
		output += `\n${lintOutput}`;
	}
	if (allDiagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
		output += `\n(Showing ${MAX_DIAGNOSTICS_PER_FILE} of ${allDiagnostics.length} diagnostics)`;
	}

	return {
		title: `${fromPath} → ${toPath}`,
		metadata: { from: fromPath, to: toPath, byteCount, diagnostics },
		output,
	};
}
