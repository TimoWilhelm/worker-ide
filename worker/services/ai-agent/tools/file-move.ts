/**
 * Tool: file_move
 * Move or rename a file.
 */

import fs from 'node:fs/promises';

import { coordinatorNamespace } from '../../../lib/durable-object-namespaces';
import { isPathSafe, isProtectedFile } from '../../../lib/path-utilities';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

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
	toolUseId?: string,
	queryChanges?: FileChange[],
): Promise<string | object> {
	const { projectRoot, projectId } = context;
	const fromPath = input.from_path;
	const toPath = input.to_path;

	if (!isPathSafe(projectRoot, fromPath) || !isPathSafe(projectRoot, toPath)) {
		return { error: 'Invalid file path' };
	}
	if (isProtectedFile(fromPath)) {
		return { error: `Cannot move protected file: ${fromPath}` };
	}

	await sendEvent('status', { message: `Moving ${fromPath} → ${toPath}...` });

	let beforeContent: string;
	try {
		beforeContent = await fs.readFile(`${projectRoot}${fromPath}`, 'utf8');
	} catch {
		return { error: `File not found: ${fromPath}` };
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

	await sendEvent('file_changed', {
		path: `${fromPath} → ${toPath}`,
		action: 'move',
		tool_use_id: toolUseId,
	});

	return { success: true, from: fromPath, to: toPath };
}
