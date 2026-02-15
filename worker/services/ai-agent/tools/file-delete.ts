/**
 * Tool: file_delete
 * Delete a file from the project.
 */

import fs from 'node:fs/promises';

import { isPathSafe, isProtectedFile } from '../../../lib/path-utilities';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Delete a file from the project. Use with caution — this action is irreversible.

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
			path: { type: 'string', description: 'File path to delete, starting with /' },
		},
		required: ['path'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	toolUseId?: string,
	queryChanges?: FileChange[],
): Promise<string | object> {
	const { projectRoot, projectId, environment } = context;
	const deletePath = input.path;

	if (!isPathSafe(projectRoot, deletePath)) {
		return { error: 'Invalid file path' };
	}
	if (isProtectedFile(deletePath)) {
		return { error: `Cannot delete protected file: ${deletePath}` };
	}

	await sendEvent('status', { message: `Deleting ${deletePath}...` });

	let beforeContent: string | Uint8Array;
	try {
		beforeContent = await fs.readFile(`${projectRoot}${deletePath}`, 'utf8');
	} catch {
		return { error: `File not found: ${deletePath}` };
	}

	await fs.unlink(`${projectRoot}${deletePath}`);

	if (queryChanges) {
		// eslint-disable-next-line unicorn/no-null -- JSON wire format
		queryChanges.push({ path: deletePath, action: 'delete', beforeContent, afterContent: null, isBinary: false });
	}

	const coordinatorId = environment.DO_PROJECT_COORDINATOR.idFromName(`project:${projectId}`);
	const coordinatorStub = environment.DO_PROJECT_COORDINATOR.get(coordinatorId);
	await coordinatorStub.fetch(
		new Request('http://internal/ws/trigger', {
			method: 'POST',
			body: JSON.stringify({ type: 'full-reload', path: deletePath, timestamp: Date.now(), isCSS: false }),
		}),
	);

	await sendEvent('file_changed', {
		path: deletePath,
		action: 'delete',
		tool_use_id: toolUseId,
		// eslint-disable-next-line unicorn/no-null -- JSON wire format
		afterContent: null,
		isBinary: false,
	});

	return { success: true, path: deletePath, action: 'delete' };
}
