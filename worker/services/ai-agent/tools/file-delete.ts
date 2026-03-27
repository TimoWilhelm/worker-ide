/**
 * Tool: file_delete
 * Delete a file from the project.
 */

import fs from 'node:fs/promises';

import { ToolErrorCode, toolError } from '@shared/tool-errors';
import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';
import { isHiddenPath, isPathSafe, isProtectedFile } from '@worker/lib/path-utilities';

import { withLock } from '../file-time';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

const DESCRIPTION = `Delete a file from the project. Use with caution — this action is irreversible.

Usage:
- The file must exist. Returns an error if the file is not found.
- Protected system files cannot be deleted.
- Triggers a full reload after deletion so the preview updates.`;

export const definition: ToolDefinition = {
	name: 'file_delete',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			file_path: { type: 'string', description: 'File path to delete, starting with /' },
		},
		required: ['file_path'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges?: FileChange[],
): Promise<ToolResult> {
	const { projectRoot, projectId } = context;
	const deletePath = input.file_path;

	if (!isPathSafe(projectRoot, deletePath)) {
		return toolError(ToolErrorCode.INVALID_PATH, 'Invalid file path');
	}
	if (isHiddenPath(deletePath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Access denied: ${deletePath}`);
	}
	if (isProtectedFile(deletePath)) {
		return toolError(ToolErrorCode.NOT_ALLOWED, `Cannot delete protected file: ${deletePath}`);
	}

	sendEvent('status', { message: `Deleting ${deletePath}...` });

	// Acquire a per-file lock to serialize against concurrent edits or writes
	// targeting the same file.
	type LockResult = ToolResult | { beforeContent: string };
	const lockResult: LockResult = await withLock<LockResult>(deletePath, async () => {
		let beforeContent: string;
		try {
			beforeContent = await fs.readFile(`${projectRoot}${deletePath}`, 'utf8');
		} catch {
			return toolError(ToolErrorCode.FILE_NOT_FOUND, `File not found: ${deletePath}`);
		}

		await fs.unlink(`${projectRoot}${deletePath}`);

		if (queryChanges) {
			queryChanges.push({ path: deletePath, action: 'delete', beforeContent, afterContent: undefined, isBinary: false });
		}

		return { beforeContent };
	});

	if ('output' in lockResult) {
		return lockResult;
	}

	const { beforeContent } = lockResult;

	const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
	const coordinatorStub = coordinatorNamespace.get(coordinatorId);
	await coordinatorStub.triggerUpdate({ type: 'full-reload', path: deletePath, timestamp: Date.now(), isCSS: false });

	sendEvent('file_changed', {
		path: deletePath,
		action: 'delete',
		isBinary: false,
	});

	const lineCount = beforeContent.split('\n').length;
	const byteCount = Buffer.byteLength(beforeContent, 'utf8');
	const output = `Deleted ${deletePath} (${lineCount} lines, ${byteCount} bytes). Remember to remove any imports or references to this file.`;

	return {
		title: deletePath,
		metadata: { lineCount, byteCount },
		output,
	};
}
